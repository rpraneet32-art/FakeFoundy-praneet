import { spawn } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ProposalStore } from "./proposals.js";
import type { TerminalApproval, TerminalRequest, TerminalResult } from "./terminal.js";

const OUTPUT_LIMIT = 16 * 1024;
const active = new WeakSet<ProposalStore>();
// --unshare-all does not satisfy bubblewrap's explicit --disable-userns check.
export const SANDBOX_NAMESPACE_ARGS = Object.freeze(["--unshare-all", "--unshare-user", "--disable-userns"]);
function decodeBounded(buffer: Buffer) {
  let text=buffer.toString("utf8");
  while(Buffer.byteLength(text)>buffer.length) text=text.slice(0,-1);
  if(text && /[\uD800-\uDBFF]/.test(text[text.length-1])) text=text.slice(0,-1);
  return text;
}
export function isSandboxRecipe(request: TerminalRequest): boolean {
  if (request.command !== "python3" || request.args[0] !== "-m" || !["pytest", "unittest"].includes(request.args[1])) return false;
  if (request.args.length > 16) return false;
  return request.args.slice(2).every(arg =>
    ["-q", "-v", "--disable-warnings", "--maxfail=1", "discover", "-s", "-p", "-k"].includes(arg) ||
    (/^[a-zA-Z0-9_][a-zA-Z0-9_./*:-]{0,200}$/.test(arg) && !arg.split(/[/:]/).includes("..")));
}

/** Bounded process supervisor. Production calls only the fixed sandbox binary. */
export async function supervise(command: string, args: string[], signal?: AbortSignal, timeoutMs = 30000): Promise<TerminalResult> {
  if (signal?.aborted) return {status:"cancelled",stdout:"",stderr:"Cancelled before execution.",truncated:false};
  return new Promise(resolve => {
    const child = spawn(command, args, { shell:false, detached:process.platform!=="win32", stdio:["ignore","pipe","pipe"], env:{PATH:"/usr/bin:/bin",LANG:"C.UTF-8"} });
    let stdout=Buffer.alloc(0), stderr=Buffer.alloc(0), bytes=0, truncated=false;
    let stopped: "cancelled"|"timed_out"|undefined;
    const kill = () => { try { if (process.platform!=="win32" && child.pid) process.kill(-child.pid,"SIGKILL"); else child.kill("SIGKILL"); } catch { /* already exited */ } };
    const cancel = () => { stopped="cancelled"; kill(); };
    signal?.addEventListener("abort",cancel,{once:true});
    if(signal?.aborted) cancel();
    const timer=setTimeout(()=>{stopped="timed_out";kill();},timeoutMs);
    const collect=(part:Buffer,stream:"stdout"|"stderr")=>{
      const available=Math.max(0,OUTPUT_LIMIT-bytes), kept=part.subarray(0,available);bytes+=kept.length;
      if(stream==="stdout") stdout=Buffer.concat([stdout,kept]);else stderr=Buffer.concat([stderr,kept]);
      if(part.length>available){truncated=true;kill();}
    };
    child.stdout.on("data",part=>collect(part,"stdout"));child.stderr.on("data",part=>collect(part,"stderr"));
    let spawnError="";
    child.on("error",error=>{spawnError=error.message;});
    child.on("close",code=>{
      clearTimeout(timer);signal?.removeEventListener("abort",cancel);
      // Kill descendants even if the recipe's parent exits early.
      kill();
      resolve({status:stopped??(code===0&&!truncated?"completed":"failed"),exitCode:code,
        stdout:decodeBounded(stdout),stderr:decodeBounded(stderr)||spawnError,truncated});
    });
  });
}

export async function runSandboxTerminal(store: ProposalStore, input: TerminalRequest, approve?: TerminalApproval, signal?: AbortSignal): Promise<TerminalResult> {
  const request=Object.freeze({command:input.command,args:Object.freeze([...input.args]),execution:"sandbox" as const});
  const unsupported=(stderr:string):TerminalResult=>({status:"unsupported",stdout:"",stderr,truncated:false});
  if(!isSandboxRecipe(request)) return unsupported("Only python3 -m pytest/unittest with bounded test paths/options is executable. No shell or arbitrary program execution.");
  if(process.platform!=="linux") return unsupported("Sandbox test execution requires Linux bubblewrap; no host fallback is permitted.");
  if(!process.getuid || process.getuid()===0) return unsupported("Sandbox test execution requires a non-root user so the no-fork process limit is enforced. No host fallback is permitted.");
  for(const path of ["/usr/bin/bwrap","/usr/bin/prlimit","/usr/bin/python3"])
    try{await access(path,constants.X_OK);}catch{return unsupported(`Required sandbox runtime is unavailable: ${path}. No host command was executed.`);}
  if(active.has(store)) return unsupported("One sandbox test may run per workspace at a time.");
  active.add(store);
  let snapshot:string|undefined;
  try {
    if(signal?.aborted) return {status:"cancelled",stdout:"",stderr:"Cancelled before approval.",truncated:false};
    if(!approve || !(await approve(request))) return {status:"denied",stdout:"",stderr:"Explicit approval was not granted. No repository code executed.",truncated:false};
    if(signal?.aborted) return {status:"cancelled",stdout:"",stderr:"Cancelled before execution.",truncated:false};
    snapshot=await mkdtemp(join(tmpdir(),"fakefoundy-test-"));
    await prepareSnapshot(store,snapshot,signal);
    const args=[...SANDBOX_NAMESPACE_ARGS,"--die-with-parent","--new-session","--uid",String(process.getuid!()),"--gid",String(process.getgid!()),"--cap-drop","ALL","--clearenv"];
    for(const path of ["/usr/bin","/usr/lib","/usr/lib64","/bin","/lib","/lib64"]) {
      try{await access(path);args.push("--ro-bind",path,path);}catch{/* optional runtime directory */}
    }
    args.push("--proc","/proc","--dev","/dev","--size","67108864","--tmpfs","/tmp","--dir","/home","--dir","/home/test",
      "--ro-bind",snapshot,"/workspace","--chdir","/workspace","--setenv","HOME","/home/test",
      "--setenv","PATH","/usr/bin:/bin","--setenv","LANG","C.UTF-8","--setenv","PYTHONPATH","/workspace/src:/workspace",
      "--setenv","PYTHONDONTWRITEBYTECODE","1","--setenv","PYTEST_DISABLE_PLUGIN_AUTOLOAD","1",
      "--setenv","PYTEST_ADDOPTS","-o cache_dir=/tmp/pytest-cache","--remount-ro","/dev","--remount-ro","/proc","--remount-ro","/",
      "--","/usr/bin/prlimit","--as=268435456","--cpu=30","--fsize=8388608","--nproc=1","--nofile=128","--",
      "/usr/bin/python3",...request.args);
    const result=await supervise("/usr/bin/bwrap",args,signal);
    if(result.status==="failed") result.stderr += "\nSandbox/test failed. No host fallback was attempted. Only system Python dependencies are available; network and dependency installation are disabled.";
    return result;
  } finally { if(snapshot) await rm(snapshot,{recursive:true,force:true});active.delete(store); }
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
/** Proposal text comes from ProposalStore.read(), which consumes one leading UTF-8 BOM. */
function withoutBom(bytes: Buffer) {
  return bytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM) ? bytes.subarray(UTF8_BOM.length) : bytes;
}

/** Snapshot-only binary reader: editor/model read tools remain text-only. */
async function readSnapshotBytes(store: ProposalStore, canonicalRoot: string, path: string): Promise<Buffer> {
  if(!path || isAbsolute(path) || path.split(/[\\/]/).includes(".."))
    throw new Error("Snapshot path escapes workspace");
  let component=canonicalRoot;
  for(const part of path.split("/")) {
    component=join(component,part);
    if((await lstat(component)).isSymbolicLink()) throw new Error("Snapshot excludes symbolic links");
  }
  const safe=await store.safePath(path);
  const file=await open(safe,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const stat=await file.stat();
    if(!stat.isFile() || stat.size>1024*1024) throw new Error("Snapshot files must be regular and at most 1 MiB");
    // The sandbox feature is Linux-only. Check the opened descriptor itself so
    // a renamed parent/symlink race cannot redirect a read outside the policy.
    const opened=await realpath(`/proc/self/fd/${file.fd}`);
    if(opened!==safe || await store.safePath(opened)!==opened)
      throw new Error("Snapshot file changed location while opening");
    const buffer=Buffer.alloc(1024*1024+1);
    let length=0;
    while(length<buffer.length) {
      const {bytesRead}=await file.read(buffer,length,buffer.length-length,null);
      if(!bytesRead) break;
      length+=bytesRead;
    }
    if(length>1024*1024) throw new Error("Snapshot file grew beyond 1 MiB");
    return buffer.subarray(0,length);
  } finally { await file.close(); }
}

/** Copies bounded regular file bytes and staged text patches; never launches repository code. */
export async function prepareSnapshot(store: ProposalStore, snapshot: string, signal?: AbortSignal): Promise<void> {
    const listing=await store.discover("",500);
    if(listing.truncated) throw new Error("Workspace exceeds the 500-file snapshot bound. Narrow the workspace; no incomplete test snapshot is executed.");
    const canonicalRoot=await realpath(store.root);
    const canonicalSnapshot=await realpath(snapshot);
    const proposals=new Map<string,{before:string;after:string}>();
    for(const proposal of store.list().map(p=>({...p}))) {
      const canonicalPath=await store.safePath(proposal.path);
      if((await store.read(canonicalPath)) !== proposal.before)
        throw new Error("File changed since proposal; regenerate before testing staged edits");
      const path=relative(canonicalRoot,canonicalPath).replaceAll("\\","/");
      if(!path || isAbsolute(path) || path.split("/").includes(".."))
        throw new Error("Proposal path escapes canonical workspace");
      proposals.set(path,{before:proposal.before,after:proposal.after});
    }
    let total=0;
    for(const path of new Set([...listing.files,...proposals.keys()])) {
      if(signal?.aborted) throw new Error("Cancelled while preparing snapshot.");
      const original=await readSnapshotBytes(store,canonicalRoot,path);
      const proposal=proposals.get(path);
      // Compare the same decoded text the proposal was staged from: a leading
      // BOM is encoding, not content, so a BOM-prefixed file is not stale.
      const source=proposal?withoutBom(original):original;
      // Validate the actual opened bytes, not just an earlier path read. The
      // user's file may change between proposal collection and this copy.
      if(proposal && !source.equals(Buffer.from(proposal.before,"utf8")))
        throw new Error("File changed while preparing snapshot; regenerate before testing staged edits");
      // Keep the original encoding mark so snapshot bytes match an editor save.
      const content=proposal
        ?Buffer.concat([original.subarray(0,original.length-source.length),Buffer.from(proposal.after,"utf8")])
        :original;
      total+=Buffer.byteLength(content);
      if(total>20*1024*1024) throw new Error("Workspace exceeds the 20 MiB snapshot bound. Nothing executed.");
      if(!path || isAbsolute(path) || path.split(/[\\/]/).includes(".."))
        throw new Error("Snapshot path escapes workspace");
      const target=resolve(canonicalSnapshot,path);
      const snapshotRelative=relative(canonicalSnapshot,target);
      if(!snapshotRelative || isAbsolute(snapshotRelative) || snapshotRelative.split(/[\\/]/).includes(".."))
        throw new Error("Snapshot destination escapes temporary directory");
      await mkdir(dirname(target),{recursive:true});
      const parentRelative=relative(canonicalSnapshot,await realpath(dirname(target)));
      if(isAbsolute(parentRelative) || parentRelative.split(/[\\/]/).includes(".."))
        throw new Error("Snapshot directory escapes temporary directory");
      await writeFile(target,content,{flag:"wx"});
    }
}
