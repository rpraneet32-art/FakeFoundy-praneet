import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProposalStore } from "../proposals.js";
import { startBridge } from "../bridge.js";
import { applyHunks } from "../hunks.js";
import { prepareSnapshot } from "../sandboxTerminal.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Editors decode a UTF-8 byte order mark instead of keeping it in the text model, so
// TextDocument.getText() never contains it. Every editor gate compares that model text
// against ProposalStore.read(), so a BOM file must read BOM-free.
const BOM = "\uFEFF";
const body = [
  "import os",
  "",
  "def get_debug_flag():",
  '    val = os.environ.get("FLASK_DEBUG")',
  "    if not val:",
  "        return True",
  '    return val.lower() not in ("0", "false", "no")',
  "",
].join("\n");

test("a UTF-8 BOM file reads exactly like the editor model, in every read path", async () => {
  const root = await mkdtemp(join(tmpdir(), "ff-bom-read-"));
  try {
    await writeFile(join(root, "helpers.py"), BOM + body, "utf8");
    const store = new ProposalStore(root);

    // TextDocument.getText() equivalent: the BOM is consumed by the decoder.
    assert.equal(await store.read("helpers.py"), body);
    assert.equal((await store.read("helpers.py")).startsWith(BOM), false);

    // Stripping the BOM must not shift line or column numbering.
    const range = await store.readRange("helpers.py", 5, 2);
    assert.equal(range.text, "    if not val:\n        return True\n");
    assert.equal(range.total_lines, 7);

    // A U+FEFF that is real content is never touched; only the leading mark is stripped.
    await writeFile(join(root, "inner.txt"), "a\uFEFFb");
    assert.equal(await store.read("inner.txt"), "a\uFEFFb");
    await writeFile(join(root, "double.txt"), BOM + BOM + "x");
    assert.equal(await store.read("double.txt"), BOM + "x");

    // Discovery and search see the same stripped text as the editor.
    const found = await store.search("flask_debug", 5);
    assert.deepEqual(found.matches.map(match => [match.path, match.line]), [["helpers.py", 4]]);
    const searched = await store.search("get_debug_flag", 5, "helpers.py");
    assert.deepEqual(searched.matches.map(match => match.line), [3]);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a CRLF file keeps its line endings through reads, ranges, patches and hunks", async () => {
  const root = await mkdtemp(join(tmpdir(), "ff-crlf-"));
  const crlf = ["import os", "", "def get_debug_flag():", "    return True", ""].join("\r\n");
  try {
    await writeFile(join(root, "helpers.py"), crlf, "utf8");
    const store = new ProposalStore(root);

    // Decoding utf8 keeps CRLF as-is, which is what the editor model holds.
    assert.equal(await store.read("helpers.py"), crlf);
    assert.equal((await store.readRange("helpers.py", 4, 1)).text, "    return True\r\n");
    assert.equal((await store.readRange("helpers.py", 1, 2)).total_lines, 4);

    store.beginRun();
    // An LF-only anchor is not the file's text: CRLF files must be quoted exactly.
    await assert.rejects(
      store.proposePatch("helpers.py", "import os\n\ndef get_debug_flag():", "import os\n\ndef get_debug_flag():  # patched"),
      /does not match original disk text/);

    const patch = await store.proposePatch("helpers.py",
      "def get_debug_flag():\r\n    return True", "def get_debug_flag():\r\n    return False");
    assert.equal(patch.before, crlf);
    assert.match(patch.after, /\r\n    return False\r\n/);
    assert.equal(patch.after.replace(/\r\n/g, "").includes("\n"), false, "no bare LF is introduced");

    // Hunk application and the review preview round-trip CRLF exactly.
    const accepted = patch.hunks.map(hunk => hunk.id);
    assert.equal(applyHunks(patch.before, patch.hunks, accepted), patch.after);
    assert.equal(store.preview(patch.id, accepted), patch.after);

    // A BOM in front of CRLF text drops only the BOM.
    await writeFile(join(root, "bomcrlf.py"), BOM + crlf, "utf8");
    assert.equal(await store.read("bomcrlf.py"), crlf);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a BOM-prefixed staged file keeps its encoding mark through prepareSnapshot",
  {skip: process.platform !== "linux" && "requires Linux /proc/self/fd"}, async () => {
  const parent = await mkdtemp(join(tmpdir(), "ff-bom-snapshot-"));
  const root = join(parent, "workspace"), snapshot = join(parent, "snapshot");
  const crlf = ["import os", "", "def get_debug_flag():", "    return True", ""].join("\r\n");
  try {
    await mkdir(root);
    await mkdir(snapshot);
    await writeFile(join(root, "helpers.py"), BOM + crlf, "utf8");
    await writeFile(join(root, "untouched.py"), BOM + crlf, "utf8");
    const store = new ProposalStore(root);
    store.beginRun();
    const patch = await store.proposePatch("helpers.py", "    return True", "    return False");
    assert.equal(patch.before, crlf, "the proposal is staged from BOM-free text");

    await prepareSnapshot(store, snapshot);

    // Staged text replaces the bytes, but the original encoding mark survives.
    assert.equal(await readFile(join(snapshot, "helpers.py"), "utf8"), BOM + patch.after);
    assert.match(await readFile(join(snapshot, "helpers.py"), "utf8"), /\r\n    return False\r\n/);
    // A BOM file with no proposal is copied byte for byte.
    assert.deepEqual(await readFile(join(snapshot, "untouched.py")), Buffer.from(BOM + crlf, "utf8"));
    // The workspace itself is never written.
    assert.equal(await readFile(join(root, "helpers.py"), "utf8"), BOM + crlf);
  } finally {
    await rm(parent, { recursive: true });
  }
});

test("inline and agent flows stage, gate-check and apply a BOM file without touching disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "ff-bom-flow-"));
  const store = new ProposalStore(root);
  const bridge = await startBridge(store, 0);
  const client = new Client({ name: "bom-flow-test", version: "1" });
  try {
    await writeFile(join(root, "helpers.py"), BOM + body, "utf8");
    store.beginRun();

    // --- Inline flow (src/inline.ts -> src/client.ts -> review) ---
    const selected = "        return True";
    const start = body.indexOf(selected);
    assert.ok(start > 0);
    store.setInlineScope({ path: "helpers.py", oldText: selected, selection: { start, document: body } });
    // The saved-buffer gate in src/inline.ts: ProposalStore.read() === document.getText().
    assert.equal(await store.read("helpers.py"), body);
    const inline = await store.proposeSelection("        return False");
    assert.equal(inline.before, body);
    assert.match(inline.after, /return False/);
    assert.equal(await readFile(join(root, "helpers.py"), "utf8"), BOM + body, "staging never writes disk");

    // --- Apply gate in src/extension.ts, then buffer-only edit ---
    assert.equal(await store.read(inline.path), inline.before, "disk read equals the staged before text");
    assert.equal(body, inline.before, "editor text equals the staged before text");
    const buffer = applyHunks(inline.before, inline.hunks, inline.hunks.map(hunk => hunk.id));
    assert.equal(buffer, inline.after);
    assert.match(buffer, /return False/);
    assert.equal(await readFile(join(root, "helpers.py"), "utf8"), BOM + body, "Apply never writes disk");

    // Editor save re-emits the BOM; the next read still matches the saved buffer.
    await writeFile(join(root, "helpers.py"), BOM + buffer, "utf8");
    assert.equal(await store.read("helpers.py"), buffer);
    store.reject(inline.id);
    store.setInlineScope();

    // --- Agent flow over the real MCP bridge ---
    store.beginRun();
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), {
      requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } },
    }));
    const related = await client.callTool({ name: "read_related_files", arguments: { files: [{ path: "helpers.py" }] } });
    assert.equal((related.content as { text: string }[])[0].text, "helpers.py\n" + buffer);

    const staged = await client.callTool({ name: "propose_patch", arguments: {
      path: "helpers.py", old_text: "        return False",
      new_text: "        return False  # unset FLASK_DEBUG means disabled",
    } });
    assert.notEqual(staged.isError, true);
    const proposal = store.list()[store.list().length - 1];
    assert.equal(proposal.before, buffer);
    assert.equal(await store.read(proposal.path), proposal.before, "Apply gate: disk read");
    assert.equal(buffer, proposal.before, "Apply gate: editor text");

    const review = await client.callTool({ name: "review_staged_edits", arguments: {} });
    assert.notEqual(review.isError, true);
    assert.equal(JSON.parse((review.content as { text: string }[])[0].text).status,
      "reviewed_pending_explicit_editor_apply");
    assert.equal(await readFile(join(root, "helpers.py"), "utf8"), BOM + buffer, "review never writes disk");

    const applied = applyHunks(proposal.before, proposal.hunks, proposal.hunks.map(hunk => hunk.id));
    assert.equal(applied, proposal.after);
    await writeFile(join(root, "helpers.py"), BOM + applied, "utf8");
    assert.equal(await store.read("helpers.py"), applied);
  } finally {
    await client.close().catch(() => undefined);
    await bridge.close();
    await rm(root, { recursive: true });
  }
});
