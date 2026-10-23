import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runtimeCases } from "./cases/index.ts";

const id = process.argv[2];
const directory = process.argv[3];
const definition = runtimeCases.find((item) => item.id === id);
if (!definition || !directory) throw new Error("Unknown case or missing directory");
const evidence = await definition.run(directory);
await writeFile(join(directory, "evidence.json"), JSON.stringify(evidence, null, 2), { flag: "wx" });