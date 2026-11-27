import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Directories written during this process, removed when the Pi session that read them ends. */
const createdDirectories = new Set<string>();

export async function writeTempTextFile(prefix: string, fileName: string, content: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	createdDirectories.add(dir);
	const outputPath = join(dir, fileName);
	await writeFile(outputPath, content, "utf8");
	return outputPath;
}

/** Removes every full-output file this process wrote. Failures are ignored: the OS cleans tmpdir eventually. */
export async function removeTempTextFiles(): Promise<void> {
	const directories = [...createdDirectories];
	createdDirectories.clear();
	await Promise.allSettled(directories.map((dir) => rm(dir, { recursive: true, force: true })));
}
