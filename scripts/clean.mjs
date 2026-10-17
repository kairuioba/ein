import { rm } from "node:fs/promises";

const generatedPaths = [
  "dist",
  "dist-electron",
  "dist-native",
  "dist-server",
  "release",
  "electron/resources/speech-helper",
  "electron/resources/Ein Speech.app",
  "electron/resources/Ein Recorder.app",
];

await Promise.all(
  generatedPaths.map((path) => rm(path, { recursive: true, force: true })),
);
