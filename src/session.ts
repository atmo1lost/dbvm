// Saved sessions: a full machine snapshot (RAM, devices and every file changed
// in the guest) gzip-compressed into the origin-private file system (OPFS), so
// a reload resumes where the user left off. A session is only valid for the
// guest image build it was taken on.

export interface SessionInfo {
  imageVersion: string;
  savedAt: number;
  bytes: number;
}

const files = (key: string) => ({ data: `session-${key}.bin.gz`, meta: `session-${key}.json` });

async function root(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

async function readFile(name: string): Promise<File | null> {
  try {
    return await (await (await root()).getFileHandle(name)).getFile();
  } catch {
    return null;
  }
}

export async function loadSession(key: string, imageVersion: string): Promise<ArrayBuffer | null> {
  const meta = await readFile(files(key).meta);
  const data = await readFile(files(key).data);
  if (!meta || !data) return null;
  const info = JSON.parse(await meta.text()) as SessionInfo;
  if (info.imageVersion !== imageVersion) return null;
  const stream = data.stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

export async function saveSession(key: string, imageVersion: string, state: ArrayBuffer): Promise<SessionInfo> {
  const dir = await root();
  // Ask the browser not to evict our storage under pressure (may be ignored).
  navigator.storage.persist?.().catch(() => {});

  // Write to a temp file first so a crash mid-save can't corrupt the last good session.
  const name = files(key).data;
  const tmp = await dir.getFileHandle(`${name}.tmp`, { create: true });
  await new Blob([state]).stream().pipeThrough(new CompressionStream("gzip")).pipeTo(await tmp.createWritable());
  const bytes = (await tmp.getFile()).size;

  const movable = tmp as FileSystemFileHandle & { move?: (name: string) => Promise<void> };
  await dir.removeEntry(name).catch(() => {});
  if (movable.move) {
    await movable.move(name);
  } else {
    await (await tmp.getFile()).stream().pipeTo(await (await dir.getFileHandle(name, { create: true })).createWritable());
    await dir.removeEntry(`${name}.tmp`);
  }

  const info: SessionInfo = { imageVersion, savedAt: Date.now(), bytes };
  const metaWritable = await (await dir.getFileHandle(files(key).meta, { create: true })).createWritable();
  await metaWritable.write(JSON.stringify(info));
  await metaWritable.close();
  return info;
}

export async function clearSession(key: string): Promise<void> {
  const dir = await root();
  for (const name of Object.values(files(key))) await dir.removeEntry(name).catch(() => {});
}
