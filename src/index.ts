/**
 * image-compress — auto-compresses pasted/referenced local images (including Orca
 * `orca-paste-*.png` clipboard temp files) into Pi `ImageContent` attachments
 * using Pi's built-in `resizeImage` (`@silvia-odwyer/photon`).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ImageContentItem {
	type: "image";
	data: string;
	mimeType: string;
}

export interface ResizeImageResult {
	data: string;
	mimeType: string;
	originalWidth: number;
	originalHeight: number;
	width: number;
	height: number;
	wasResized: boolean;
}

export type ResizeImageFn = (
	bytes: Uint8Array,
	mimeType: string,
	options?: {
		maxWidth?: number;
		maxHeight?: number;
		maxBytes?: number;
		jpegQuality?: number;
	},
) => Promise<ResizeImageResult | null>;

export const IMAGE_MAX_EDGE = 1600;
export const IMAGE_MAX_BYTES = 1_500_000;
export const IMAGE_JPEG_QUALITY = 80;
const MAX_SOURCE_FILE_BYTES = 25 * 1024 * 1024;
const MAX_IMAGES_PER_TURN = 8;

const IMAGE_PATH_RE =
	/["']([^"'\r\n]+?\.(?:png|jpe?g|gif|webp|bmp))["']|(?<=^|[\s(\[:=])([^\s"'`<>()[\]{},;]+?\.(?:png|jpe?g|gif|webp|bmp))(?=$|[\s)\]}>,.;:!?'"`])/gi;
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp)$/i;
const ORCA_TEMP_IMAGE_RE = /^orca-paste-.+\.(?:png|jpe?g|gif|webp|bmp)$/i;

const MIME_BY_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
};

function detectImageExt(bytes: Buffer): string | undefined {
	if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
		return "png";
	}
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return "jpg";
	}
	if (bytes.length >= 4 && bytes.subarray(0, 4).toString("ascii") === "GIF8") {
		return "gif";
	}
	if (
		bytes.length >= 12 &&
		bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
		bytes.subarray(8, 12).toString("ascii") === "WEBP"
	) {
		return "webp";
	}
	if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
		return "bmp";
	}
	return undefined;
}

function resolveCandidatePath(rawToken: string, cwd: string): string | undefined {
	let token = rawToken.trim();
	if (!token) return undefined;
	if (token.startsWith("@")) token = token.slice(1);
	if (/^file:\/\//i.test(token)) {
		try {
			token = new URL(token).pathname;
		} catch {
			return undefined;
		}
	}
	if (/^https?:\/\//i.test(token)) return undefined;
	if (token.startsWith("~/")) {
		token = path.join(homedir(), token.slice(2));
	}
	const resolved = path.isAbsolute(token) ? path.normalize(token) : path.resolve(cwd, token);
	if (!existsSync(resolved) && token.includes("\\")) {
		const unescaped = token.replace(/\\(.)/g, "$1");
		const fallback = path.isAbsolute(unescaped) ? path.normalize(unescaped) : path.resolve(cwd, unescaped);
		if (existsSync(fallback)) return fallback;
	}
	return resolved;
}

function formatImageLabel(label: string, filePath: string): string {
	return `[${label}](${pathToFileURL(filePath).href})`;
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function defaultResizeImage(
	bytes: Uint8Array,
	mimeType: string,
	options?: {
		maxWidth?: number;
		maxHeight?: number;
		maxBytes?: number;
		jpegQuality?: number;
	},
): Promise<ResizeImageResult | null> {
	try {
		const mod = (await import("@earendil-works/pi-coding-agent")) as {
			resizeImage?: ResizeImageFn;
		};
		if (typeof mod.resizeImage !== "function") return null;
		return await mod.resizeImage(bytes, mimeType, options);
	} catch {
		return null;
	}
}

async function compressImageBytes(
	bytes: Buffer,
	mimeType: string,
	resizer: ResizeImageFn,
): Promise<{ data: string; mimeType: string }> {
	const resized = await resizer(bytes, mimeType, {
		maxWidth: IMAGE_MAX_EDGE,
		maxHeight: IMAGE_MAX_EDGE,
		maxBytes: IMAGE_MAX_BYTES,
		jpegQuality: IMAGE_JPEG_QUALITY,
	});
	if (resized?.data) {
		return { data: resized.data, mimeType: resized.mimeType || mimeType };
	}
	return { data: bytes.toString("base64"), mimeType };
}

function removeOrcaTempFile(filePath: string): void {
	if (!ORCA_TEMP_IMAGE_RE.test(path.basename(filePath))) return;
	try {
		rmSync(filePath, { force: true });
	} catch {
		// Best-effort cleanup of Orca temp paste files.
	}
}

export function extractImagePasteFromTerminalInput(
	data: string,
	cwd: string,
): { path: string; trailingSpace: string } | undefined {
	if (!data) return undefined;
	const unwrapped = data.replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, "");
	const trailingSpace = /[ \t]$/.test(unwrapped) ? " " : "";
	let token = unwrapped.trim();
	if (!token || /[\r\n]/.test(token)) return undefined;
	if (
		(token.startsWith('"') && token.endsWith('"')) ||
		(token.startsWith("'") && token.endsWith("'"))
	) {
		token = token.slice(1, -1).trim();
	}
	const resolved = resolveCandidatePath(token, cwd);
	if (!resolved || !IMAGE_EXT_RE.test(resolved)) return undefined;
	try {
		if (!existsSync(resolved)) return undefined;
		const st = statSync(resolved);
		if (!st.isFile() || st.size === 0 || st.size > MAX_SOURCE_FILE_BYTES) return undefined;
		return { path: resolved, trailingSpace };
	} catch {
		return undefined;
	}
}

export const extractOrcaPasteFromTerminalInput = extractImagePasteFromTerminalInput;

export async function transformImageInput(
	input: {
		text: string;
		images?: ImageContentItem[];
		cwd: string;
		placeholders?: ReadonlyMap<string, string>;
	},
	resizer: ResizeImageFn = defaultResizeImage,
): Promise<{ changed: boolean; text: string; images: ImageContentItem[] | undefined }> {
	const existingImages = input.images ?? [];
	const seenHashes = new Set<string>();
	const nextImages: ImageContentItem[] = [];
	let changed = false;

	// Compress any oversized pre-attached images as well.
	for (const img of existingImages) {
		if (!img?.data) continue;
		const rawBytes = Buffer.from(img.data, "base64");
		seenHashes.add(sha256Hex(rawBytes));
		if (rawBytes.byteLength > IMAGE_MAX_BYTES) {
			const compressed = await compressImageBytes(rawBytes, img.mimeType || "image/png", resizer);
			if (compressed.data !== img.data) changed = true;
			nextImages.push({ type: "image", data: compressed.data, mimeType: compressed.mimeType });
		} else {
			nextImages.push(img);
		}
	}

	let nextText = input.text;
	const seenPaths = new Set<string>();
	const labelsByHash = new Map<string, string>();
	for (let idx = 0; idx < nextImages.length; idx += 1) {
		const img = nextImages[idx];
		if (img?.data) {
			labelsByHash.set(sha256Hex(Buffer.from(img.data, "base64")), `[image${idx + 1}]`);
		}
	}

	// Resolve `[imageN]` placeholders inserted into the editor during typing.
	if (input.text && input.placeholders?.size) {
		for (const [label, filePath] of input.placeholders) {
			if (nextImages.length >= MAX_IMAGES_PER_TURN) break;
			if (!nextText.includes(label) || seenPaths.has(filePath)) continue;
			seenPaths.add(filePath);
			try {
				if (!existsSync(filePath)) continue;
				const st = statSync(filePath);
				if (!st.isFile() || st.size === 0 || st.size > MAX_SOURCE_FILE_BYTES) continue;
				const bytes = readFileSync(filePath);
				const ext = detectImageExt(bytes);
				if (!ext) continue;
				const rawHash = sha256Hex(bytes);
				if (seenHashes.has(rawHash)) continue;
				seenHashes.add(rawHash);
				const compressed = await compressImageBytes(bytes, MIME_BY_EXT[ext] ?? "image/png", resizer);
				nextImages.push({ type: "image", data: compressed.data, mimeType: compressed.mimeType });
				labelsByHash.set(rawHash, label);
				const formatted = formatImageLabel(label, filePath);
				if (formatted !== label) {
					nextText = nextText.replaceAll(label, formatted);
				}
				changed = true;
			} catch {
				// Unreadable file — leave placeholder untouched.
			}
		}
	}

	if (input.text) {
		const replacements: Array<{ token: string; label: string }> = [];
		IMAGE_PATH_RE.lastIndex = 0;

		for (const match of input.text.matchAll(IMAGE_PATH_RE)) {
			if (nextImages.length >= MAX_IMAGES_PER_TURN) break;
			const rawToken = match[1] ?? match[2];
			if (!rawToken) continue;
			const resolved = resolveCandidatePath(rawToken, input.cwd);
			if (!resolved || seenPaths.has(resolved)) continue;
			seenPaths.add(resolved);

			try {
				if (!existsSync(resolved)) continue;
				const st = statSync(resolved);
				if (!st.isFile() || st.size === 0 || st.size > MAX_SOURCE_FILE_BYTES) continue;
				const bytes = readFileSync(resolved);
				const ext = detectImageExt(bytes);
				if (!ext) continue;
				const rawHash = sha256Hex(bytes);
				if (seenHashes.has(rawHash)) {
					replacements.push({
						token: match[0],
						label: formatImageLabel(labelsByHash.get(rawHash) ?? "[image1]", resolved),
					});
					continue;
				}
				seenHashes.add(rawHash);

				const compressed = await compressImageBytes(bytes, MIME_BY_EXT[ext] ?? "image/png", resizer);
				nextImages.push({ type: "image", data: compressed.data, mimeType: compressed.mimeType });
				const label = `[image${nextImages.length}]`;
				labelsByHash.set(rawHash, label);
				changed = true;

				replacements.push({ token: match[0], label: formatImageLabel(label, resolved) });
			} catch {
				// Unreadable file — leave prompt text untouched.
			}
		}

		for (const { token, label } of replacements) {
			nextText = nextText.replaceAll(token, label);
		}
	}

	if (!changed) {
		return { changed: false, text: input.text, images: input.images };
	}
	return {
		changed: true,
		text: nextText,
		images: nextImages.length > 0 ? nextImages : undefined,
	};
}

export interface TextSegment {
	segment: string;
	index: number;
	input: string;
	isWordLike?: boolean;
}

/**
 * Merges active `[imageN]` placeholders into single atomic segments so Editor
 * backspace, forward-delete, cursor navigation, word-wrap, and mouse click
 * treat the whole `[imageN]` token as one unit (matching `[paste #N]`).
 */
export function mergeImagePlaceholderSegments(
	baseSegments: Iterable<TextSegment>,
	text: string,
	placeholders: ReadonlyMap<string, string>,
): Iterable<TextSegment> {
	if (placeholders.size === 0 || !text.includes("[image")) return baseSegments;
	const spans: Array<{ start: number; end: number }> = [];
	for (const m of text.matchAll(/\[image\d+\]/g)) {
		if (m.index === undefined || !placeholders.has(m[0])) continue;
		spans.push({ start: m.index, end: m.index + m[0].length });
	}
	if (spans.length === 0) return baseSegments;

	const merged: TextSegment[] = [];
	let spanIdx = 0;
	for (const seg of baseSegments) {
		while (spanIdx < spans.length && spans[spanIdx]!.end <= seg.index) {
			spanIdx += 1;
		}
		const span = spans[spanIdx];
		if (span && seg.index >= span.start && seg.index < span.end) {
			if (seg.index === span.start) {
				merged.push({
					segment: text.slice(span.start, span.end),
					index: span.start,
					input: text,
				});
			}
		} else {
			merged.push(seg);
		}
	}
	return merged;
}

export function decorateEditorPlaceholders(
	line: string,
	placeholders: ReadonlyMap<string, string>,
): string {
	if (placeholders.size === 0 || !line.includes("[image")) return line;
	return line.replace(/\[image\d+\]/g, (label) => {
		const filePath = placeholders.get(label);
		if (!filePath) return label;
		const url = pathToFileURL(filePath).href;
		return `\x1b]8;;${url}\x07\x1b[4m${label}\x1b[24m\x1b]8;;\x07`;
	});
}

export default function imageCompressExtension(pi: ExtensionAPI) {
	const placeholders = new Map<string, string>();
	const placeholderHashes = new Map<string, string>();
	let unsubscribeTerminalInput: (() => void) | undefined;
	let disposed = false;

	const cleanupPlaceholders = () => {
		placeholders.clear();
		placeholderHashes.clear();
	};

	const cleanupTerminalListener = () => {
		unsubscribeTerminalInput?.();
		unsubscribeTerminalInput = undefined;
	};

	const nextPlaceholderLabel = (): string => {
		let idx = 1;
		while (placeholders.has(`[image${idx}]`)) idx += 1;
		return `[image${idx}]`;
	};

	pi.on("session_start", (_event, ctx) => {
		disposed = false;
		cleanupTerminalListener();
		cleanupPlaceholders();
		if (!ctx.hasUI || typeof ctx.ui.onTerminalInput !== "function") return;
		if (typeof ctx.ui.setEditorComponent === "function" && !ctx.ui.getEditorComponent?.()) {
			void import("@earendil-works/pi-coding-agent")
				.then(({ CustomEditor }) => {
					if (disposed || !CustomEditor || ctx.ui.getEditorComponent?.()) return;
					class ImageLinkEditor extends CustomEditor {
						constructor(
							tui: ConstructorParameters<typeof CustomEditor>[0],
							theme: ConstructorParameters<typeof CustomEditor>[1],
							keybindings: ConstructorParameters<typeof CustomEditor>[2],
						) {
							super(tui, theme, keybindings, { embedWorkingStatus: true });
							const protoSegment = (
								CustomEditor.prototype as unknown as {
									segment?: (text: string, mode: "grapheme" | "word") => Iterable<TextSegment>;
								}
							).segment;
							if (typeof protoSegment === "function") {
								(
									this as unknown as {
										segment: (text: string, mode: "grapheme" | "word") => Iterable<TextSegment>;
									}
								).segment = (text, mode) =>
									mergeImagePlaceholderSegments(protoSegment.call(this, text, mode), text, placeholders);
							}
						}

						override render(width: number): string[] {
							const lines = super.render(width);
							if (placeholders.size === 0) return lines;
							return lines.map((line) => decorateEditorPlaceholders(line, placeholders));
						}
					}
					ctx.ui.setEditorComponent((tui, theme, keybindings) => new ImageLinkEditor(tui, theme, keybindings));
				})
				.catch(() => {
					// CustomEditor unavailable (e.g. unit test environment without Pi host package).
				});
		}
		unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) => {
			const match = extractImagePasteFromTerminalInput(data, ctx.cwd ?? process.cwd());
			if (!match) return undefined;

			// Prune placeholders (and their Orca temp files) if the user deleted them from the editor.
			const editorText = ctx.ui.getEditorText();
			for (const [existingLabel, existingPath] of placeholders) {
				if (!editorText.includes(existingLabel)) {
					placeholders.delete(existingLabel);
					placeholderHashes.delete(existingLabel);
					removeOrcaTempFile(existingPath);
				}
			}

			let incomingHash: string | undefined;
			try {
				incomingHash = sha256Hex(readFileSync(match.path));
			} catch {
				// Best-effort dedupe; path check still applies.
			}

			let label: string | undefined;
			for (const [existingLabel, existingPath] of placeholders) {
				if (
					existingPath === match.path ||
					(incomingHash !== undefined && placeholderHashes.get(existingLabel) === incomingHash)
				) {
					label = existingLabel;
					if (existingPath !== match.path) {
						removeOrcaTempFile(match.path);
					}
					break;
				}
			}
			if (!label) {
				label = nextPlaceholderLabel();
				placeholders.set(label, match.path);
				if (incomingHash !== undefined) {
					placeholderHashes.set(label, incomingHash);
				}
			}

			// Rewrite the terminal paste in-place so TUI forwards it to the focused editor
			// and immediately schedules a render (pasteToEditor + consume skips requestRender).
			return { data: `\x1b[200~${label}${match.trailingSpace}\x1b[201~` };
		});
	});

	pi.on("session_shutdown", () => {
		disposed = true;
		cleanupTerminalListener();
		cleanupPlaceholders();
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		const result = await transformImageInput({
			text: event.text,
			images: event.images as ImageContentItem[] | undefined,
			cwd: ctx?.cwd ?? process.cwd(),
			placeholders,
		});
		cleanupPlaceholders();
		if (!result.changed) return { action: "continue" };
		return {
			action: "transform",
			text: result.text,
			images: result.images,
		};
	});
}
