import type { FileSettings } from "./types";

export const FONT_SIZES = [
  9, 10, 11, 12, 13, 14, 16, 18, 20, 22, 24, 26, 28, 32, 36, 40, 46,
];
export const DEFAULT_FILE_SETTINGS: FileSettings = {
  rememberSession: true,
  restoreOpenFiles: true,
  rememberPositions: true,
  defaultMode: "preview",
  wrapLines: true,
  lineNumbers: true,
  previewLayout: "boxed",
  previewWidth: 960,
  fullWidthPadding: 16,
  editorFontSize: 12,
  previewFontSize: 13,
};

export function fileSettings(value?: Partial<FileSettings>): FileSettings {
  return { ...DEFAULT_FILE_SETTINGS, ...value };
}

export function stepFontSize(size: number, direction: number) {
  return direction > 0
    ? (FONT_SIZES.find((value) => value > size) ?? 46)
    : ([...FONT_SIZES].reverse().find((value) => value < size) ?? 9);
}

export const isPreviewImage = (path: string) => /\.(png|jpe?g)$/i.test(path);
