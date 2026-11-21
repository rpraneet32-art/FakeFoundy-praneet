import { realpath, readFile, stat, readdir } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { diffHunks, applyHunks, Hunk } from "./hunks.js";
export interface Proposal {
  hunks: Hunk[];
  id: string;
  path: string;
  before: string;
  after: string;
}
export interface InlineScope {
  path: string;
  oldText: string;
  selection?: {start: number; document: string};
}
/** No agent-facing tool can apply a proposal. Only the editor's explicit review can. */
export class ProposalStore {
  private items = new Map<string, Proposal>();
  private patchEdits = new Map<string, {start:number; end:number; text:string}[]>();
  private patchGenerations = new Map<string, number>();
  private patchQueues = new Map<string, Promise<void>>();
  private generation = 0;
  private active = true;
  private inlineScope?: InlineScope;
  setInlineScope(scope?: InlineScope) {
    this.inlineScope = scope ? {...scope, selection: scope.selection && {...scope.selection}} : undefined;
  }
  beginRun() { this.generation++; this.active = true; }
  endRun() { this.generation++; this.active = false; }
  constructor(readonly root: string) {}
  async safePath(path: string): Promise<string> {
    const sensitive = (p: string) =>
      p
        .split(/[\\/]/)
        .some(
          (part) =>
            [
              ".git",
              ".ssh",
              ".aws",
              ".gnupg",
              ".npmrc",
              ".netrc",
              "id_rsa",
              "id_ed25519",
            ].includes(part) ||
            part === ".env" ||
            part.startsWith(".env.") ||
            /\.(pem|key|p12|pfx)$/i.test(part),
        );
    if (sensitive(path))
      throw new Error("Sensitive file paths are not exposed to the agent");
    const root = await realpath(this.root);
    const target = await realpath(resolve(root, path));
    const rel = relative(root, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel))
      throw new Error("File must be inside workspace");
    if (sensitive(rel))
      throw new Error("Sensitive file paths are not exposed to the agent");
    const info = await stat(target);
    if (!info.isFile() || info.size > 1024 * 1024)
      throw new Error("Only regular files up to 1 MiB are supported");
    return target;
  }
  async read(path: string) {
    // Editors consume a UTF-8 byte order mark while decoding, so TextDocument.getText()
    // never contains it. Strip exactly one leading BOM so disk text and the editor model
    // agree; any U+FEFF elsewhere in the file is content and stays intact.
    const content = (await readFile(await this.safePath(path), "utf8")).replace(/^\uFEFF/, "");
    if (content.includes("\0")) throw new Error("Binary files are not supported");
    return content;
  }
  /** Small, exact, paginated excerpts. Continuation preserves even very long lines. */
  async readRange(path: string, startLine = 1, maxLines = 40, startColumn = 0) {
    if (!Number.isInteger(startLine) || startLine<1 || !Number.isInteger(maxLines) || maxLines<1 || maxLines>80 || !Number.isInteger(startColumn) || startColumn<0)
      throw new Error("Invalid range: positive start_line, max_lines 1..80, nonnegative start_column required");
    const source=await this.read(path);
    const lines=source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    if (startLine>lines.length+1 || (startLine===lines.length+1 && startColumn!==0) || (startLine<=lines.length && startColumn>lines[startLine-1].length))
      throw new Error("Read range is outside file");
    let line=startLine-1, column=startColumn, text="";
    const stop=Math.min(lines.length,line+maxLines);
    // UTF-16 offsets are explicit; avoid splitting surrogate pairs at page boundaries.
    while(line<stop && text.length<8000) {
      const remaining=lines[line].slice(column);
      let count=Math.min(remaining.length,8000-text.length);
      if(count<remaining.length && count>0 && /[\uD800-\uDBFF]/.test(remaining[count-1])) count--;
      if(!count && remaining.length) break;
      text+=remaining.slice(0,count);column+=count;
      if(column===lines[line].length) {line++;column=0;} else break;
    }
    const hasMore=line<lines.length;
    return {path,start_line:startLine,start_column:startColumn,text,total_lines:lines.length,
      has_more:hasMore,next:hasMore?{start_line:line+1,start_column:column}:null};
  }
  private async stage(path: string, before: string, content: string, generation: number, exclusive = false, replace?: Proposal): Promise<Proposal> {
    if (before === content) throw new Error("Proposed edit would make no changes");
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error("Proposal exceeds 1 MiB");
    const p = {id:replace?.id ?? randomUUID(), path:await this.safePath(path), before,
      hunks:diffHunks(before,content), after:content};
    if (!this.active || generation !== this.generation) throw new Error("Agent run ended; proposal discarded");
    if (exclusive) {
      const current=this.list().filter(existing=>existing.path===p.path);
      if (replace ? current.length!==1 || current[0]!==replace : current.length!==0)
        throw new Error("Conflicting pending proposal changed while staging; reread and retry");
    }
    this.items.set(p.id,p);
    return p;
  }
  async propose(path: string, content: string): Promise<Proposal> {
    if (this.inlineScope) throw new Error("Inline edits require propose_selection with replacement text only; full-file replacement is disabled");
    const generation=this.generation;
    if (!this.active) throw new Error("No active agent run");
    return this.stage(path,await this.read(path),content,generation);
  }
  /** Inline-only: selection identity stays server-side; model sends replacement text only. */
  async proposeSelection(newText: string): Promise<Proposal> {
    const scope=this.inlineScope;
    if (!scope) throw new Error("propose_selection requires an active inline selection");
    return this.proposePatch(scope.path,scope.oldText,newText);
  }
  /** Exact replacement, never interprets new_text as an entire file. No disk writes. */
  async proposePatch(path: string, oldText: string, newText: string, replaceExisting = false): Promise<Proposal> {
    const generation=this.generation;
    const scope=this.inlineScope;
    if (!this.active) throw new Error("No active agent run");
    if (!oldText) throw new Error("old_text must be non-empty");
    if (Buffer.byteLength(oldText)>24000 || Buffer.byteLength(newText)>24000 || oldText.split("\n").length>200)
      throw new Error("Patch range too large: use disjoint original ranges of at most 200 lines and 24 KB each");
    const target=await this.safePath(path);
    if (scope && (target!==await this.safePath(scope.path) || oldText!==scope.oldText))
      throw new Error("Inline patch must target exactly the selected file and selected old_text");
    // Serialize same-file requests so concurrent disjoint patches compose deterministically.
    const previous=this.patchQueues.get(target) ?? Promise.resolve();
    let release!:()=>void;
    const lock=new Promise<void>(resolve=>{release=resolve;});
    const tail=previous.then(()=>lock);
    this.patchQueues.set(target,tail);
    await previous;
    try {
      const pending=this.list().filter(p=>p.path===target);
      if (pending.length>1 || (pending.length && !this.patchEdits.has(pending[0].id)))
        throw new Error("Conflicting full-file proposal; cannot compose patches with it");
      const existing=pending[0];
      if (existing && this.patchGenerations.get(existing.id)!==generation)
        throw new Error("Pending patch belongs to an earlier run; review or reject it before starting another run");
      const before=await this.read(target);
      if (existing && existing.before!==before) throw new Error("File changed since proposal; regenerate it");
      const edits = existing ? this.patchEdits.get(existing.id)! : [];
      const anchors = replaceExisting ? edits.filter(edit => edit.end - edit.start <= 1000)
        .slice(0, 3).map(edit => before.slice(edit.start, edit.end)) : [];
      const revisionHint = anchors.length ? ` Valid original old_text values for staged revisions: ${JSON.stringify(anchors)}.` : "";
      const selection = scope?.selection;
      if (selection && (before !== selection.document || before.slice(selection.start, selection.start + oldText.length) !== oldText))
        throw new Error("File changed since the inline selection was captured; select the code again");
      const originalIndex = selection?.start ?? before.indexOf(oldText);
      const exact = replaceExisting ? edits.find(edit => edit.start === originalIndex && edit.end === originalIndex + oldText.length) : undefined;
      const matches = !exact && (replaceExisting || originalIndex < 0)
        ? edits.filter(edit => edit.text.includes(oldText)) : [];
      const staged = matches[0];
      const stagedIndex = staged?.text.indexOf(oldText) ?? -1;
      const revision = matches.length === 1 && staged.text.indexOf(oldText, stagedIndex + 1) < 0 ? staged : undefined;
      if (revision && !replaceExisting) {
        throw new Error("old_text matches the current staged replacement exactly. Resend the same patch with replace_existing: true.");
      }
      if (originalIndex < 0 && !revision) {
        if (revisionHint) throw new Error(`old_text does not match the original disk text. Nothing was staged.${revisionHint}`);
        if (oldText.includes("\\n")) {
          const decoded=oldText.replace(/\\r\\n/g,"\r\n").replace(/\\n/g,"\n");
          if (before.includes(decoded))
            throw new Error("old_text contains literal backslash-n sequences instead of actual newline characters. Send the same text with real newlines in the parsed string; JSON-encode once, not twice. Nothing was staged. Do not reread or search: correct this argument and retry once.");
        }
        const hint = oldText.split(/\r?\n/).find(line => {
          if (line.trim().length < 8 || line.length > 200) return false;
          const at = before.indexOf(line);
          return at >= 0 && (at === 0 || before[at - 1] === "\n")
            && /^(?:\r?\n|$)/.test(before.slice(at + line.length, at + line.length + 2))
            && before.indexOf(line, at + 1) < 0;
        });
        if (hint) {
          const line = before.slice(0, before.indexOf(hint)).split("\n").length;
          throw new Error(`old_text does not match original disk text. Nothing was staged. Original line ${line} matches exactly: ${JSON.stringify(hint)}. For an insertion, use just this line as old_text and preserve it in new_text. For a replacement, read the exact range around line ${line}.`);
        }
        throw new Error("old_text does not match original disk text. Nothing was staged. Read only the target line range with fakefoundy_read_file, copy a short unique anchor exactly, then correct the patch; do not restart repository discovery.");
      }
      if (!selection && !revision && before.indexOf(oldText,originalIndex+1)>=0) throw new Error("old_text is not unique; include more context");
      const replaced = exact ?? revision;
      if (replaceExisting && !replaced)
        throw new Error(`No staged patch has that exact original range or a unique staged match. Omit replace_existing for a new disjoint patch.${revisionHint}`);
      const index = replaced?.start ?? originalIndex;
      const end = replaced?.end ?? originalIndex + oldText.length;
      const text = revision ? revision.text.replace(oldText, () => newText) : newText;
      if (Buffer.byteLength(text) > 24000) throw new Error("Revised patch range exceeds 24 KB");
      const retained = edits.filter(edit => edit !== replaced);
      if (retained.some(edit=>index<edit.end && end>edit.start))
        throw new Error("Conflicting patch overlaps a previously staged original range. To revise it, set replace_existing: true with its exact original range or a unique snippet from its staged replacement.");
      const combined=[...retained,{start:index,end,text}].sort((a,b)=>b.start-a.start);
      let after=before;
      for (const edit of combined) after=after.slice(0,edit.start)+edit.text+after.slice(edit.end);
      const p=await this.stage(target,before,after,generation,true,existing);
      this.patchEdits.set(p.id,combined);
      this.patchGenerations.set(p.id,generation);
      return p;
    } finally {
      release();
      if (this.patchQueues.get(target)===tail) this.patchQueues.delete(target);
    }
  }

  /** Bounded discovery: never follows symlink directories or exposes hidden/generated trees. */
  async discover(query = "", limit = 100, options: {signal?: AbortSignal; prioritize?: (path: string) => number} = {}) {
    const files: string[] = [];
    // Git supplies ignore semantics without executing project code or a shell.
    let allowed: Set<string> | undefined;
    try {
      const {stdout} = await promisify(execFile)("git", ["-C", this.root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {timeout:2000,maxBuffer:8*1024*1024,signal:options.signal});
      allowed = new Set(stdout.split("\0").filter(Boolean));
    } catch {
      options.signal?.throwIfAborted();
      // An incomplete Git inventory cannot enforce ignore rules.
      if (await promisify(execFile)("git", ["-C", this.root, "rev-parse", "--is-inside-work-tree"],
        {timeout:2000,signal:options.signal}).then(() => true, () => false)) return {files, truncated:true};
    }

    const pending = [""];
    let scanned = 0;
    const cap = Math.max(1, Math.min(limit, 500));
    const candidates: string[] = [];
    const prioritize = options.prioritize;
    const omitted = new Set(["node_modules", "dist", "build", "coverage", "vendor", "__pycache__"]);
    const directories = new Set<string>();
    for (const path of allowed ?? []) {
      for (let at = path.lastIndexOf("/"); at > 0; at = path.lastIndexOf("/", at - 1)) {
        const dir = path.slice(0, at);
        if (directories.has(dir)) break;
        directories.add(dir);
      }
    }
    const match = query.toLowerCase();
    while (pending.length && (prioritize || files.length < cap) && scanned < 5000) {
      options.signal?.throwIfAborted();
      const dir = pending.pop()!;
      const entries = await readdir(resolve(this.root, dir), {withFileTypes:true});
      entries.sort((a,b)=>a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.name.startsWith(".") || omitted.has(entry.name) || entry.isSymbolicLink()) continue;
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory() && allowed && !directories.has(path)) continue;
        if (entry.isFile() && allowed && !allowed.has(path)) continue;
        if (++scanned > 5000 || (!prioritize && files.length >= cap)) break;
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile() && path.toLowerCase().includes(match)) {
          if (prioritize) candidates.push(path);
          else {
            try { await this.safePath(path); files.push(path); } catch { /* protected file */ }
          }
        }
      }
    }
    if (prioritize) {
      const ranked = candidates.map(path => ({path, score: prioritize(path)}));
      ranked.sort((a,b) => b.score - a.score);
      for (const {path} of ranked) {
        options.signal?.throwIfAborted();
        if (files.length >= cap) break;
        try { await this.safePath(path); files.push(path); } catch { /* protected file */ }
      }
    }
    return {files, truncated: pending.length > 0 || files.length >= cap || scanned >= 5000};
  }
  async search(query: string, limit = 50, onlyPath?: string) {
    if (!query) throw new Error("Search text must not be empty");
    const candidates = await this.discover(onlyPath ?? "", 500);
    const matches: {path:string; line:number; text:string}[] = [];
    const cap = Math.max(1, Math.min(limit, 100));
    let bytes = 0;
    for (const path of candidates.files) {
      if (onlyPath && path !== onlyPath) continue;
      let content: string;
      try {content = await this.read(path);} catch {continue;}
      bytes += Buffer.byteLength(content);
      if (bytes > 5 * 1024 * 1024) return {matches,truncated:true};
      for (const [index,line] of content.split("\n").entries()) {
        if (line.toLowerCase().includes(query.toLowerCase())) matches.push({path,line:index+1,text:line.slice(0,500)});
        if (matches.length >= cap) return {matches,truncated:true};
      }
    }
    return {matches,truncated:candidates.truncated};
  }
  preview(id: string, accepted: readonly number[]) {
    const p = this.get(id);
    return applyHunks(p.before, p.hunks, accepted);
  }
  list() {
    return [...this.items.values()];
  }
  get(id: string) {
    const p = this.items.get(id);
    if (!p) throw new Error("Unknown proposal");
    return p;
  }
  reject(id: string) {
    this.patchEdits.delete(id);
    this.patchGenerations.delete(id);
    this.items.delete(id);
  }
}
