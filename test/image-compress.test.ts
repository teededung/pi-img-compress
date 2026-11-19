import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import imageCompressExtension, {
	decorateEditorPlaceholders,
	extractImagePasteFromTerminalInput,
	extractOrcaPasteFromTerminalInput,
	IMAGE_JPEG_QUALITY,
	IMAGE_MAX_BYTES,
	IMAGE_MAX_EDGE,
	mergeImagePlaceholderSegments,
	transformImageInput,
	type ResizeImageFn,
} from "../src/index.ts";

const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64",
);
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

describe("pi-img-compress", () => {
	test("compresses temp paste and referenced image paths, attaches ImageContent, and rewrites links", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pi-img-compress-"));
		const orcaPath = path.join(dir, "orca-paste-1794716077100.png");
		const projectShot = path.join(dir, "shot.png");
		const fakeTxtPng = path.join(dir, "fake.png");
		writeFileSync(orcaPath, TINY_PNG);
		writeFileSync(projectShot, FAKE_JPEG);
		writeFileSync(fakeTxtPng, "not an image");

		const calls: Array<{ mimeType: string; maxBytes?: number; maxWidth?: number }> = [];
		const mockResizer: ResizeImageFn = async (_bytes, mimeType, opts) => {
			calls.push({ mimeType, maxBytes: opts?.maxBytes, maxWidth: opts?.maxWidth });
			return {
				data: Buffer.from("compressed").toString("base64"),
				mimeType: "image/jpeg",
				originalWidth: 3000,
				originalHeight: 2000,
				width: 1600,
				height: 1067,
				wasResized: true,
			};
		};

		try {
			const res = await transformImageInput(
				{
					text: `Check this:\n${orcaPath}\nAnd @shot.png + https://example.com/a.png + ${fakeTxtPng}`,
					cwd: dir,
				},
				mockResizer,
			);

			assert.equal(res.changed, true);
			assert.equal(
				res.text,
				`Check this:\n[[image1]](${pathToFileURL(orcaPath).href})\nAnd [[image2]](${pathToFileURL(projectShot).href}) + https://example.com/a.png + ${fakeTxtPng}`,
			);
			assert.deepEqual(res.images, [
				{ type: "image", data: Buffer.from("compressed").toString("base64"), mimeType: "image/jpeg" },
				{ type: "image", data: Buffer.from("compressed").toString("base64"), mimeType: "image/jpeg" },
			]);
			assert.deepEqual(calls, [
				{ mimeType: "image/png", maxBytes: IMAGE_MAX_BYTES, maxWidth: IMAGE_MAX_EDGE },
				{ mimeType: "image/jpeg", maxBytes: IMAGE_MAX_BYTES, maxWidth: IMAGE_MAX_EDGE },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("compresses oversized pre-attached images and leaves small ones untouched", async () => {
		const smallBase64 = TINY_PNG.toString("base64");
		const bigBytes = Buffer.concat([TINY_PNG, Buffer.alloc(IMAGE_MAX_BYTES + 128, 0x41)]);
		const bigBase64 = bigBytes.toString("base64");

		let resizerCalled = 0;
		const mockResizer: ResizeImageFn = async (_bytes, _mimeType, opts) => {
			resizerCalled += 1;
			assert.equal(opts?.jpegQuality, IMAGE_JPEG_QUALITY);
			return {
				data: smallBase64,
				mimeType: "image/jpeg",
				originalWidth: 2500,
				originalHeight: 1500,
				width: 1600,
				height: 960,
				wasResized: true,
			};
		};

		const unchanged = await transformImageInput(
			{
				text: "hello",
				images: [{ type: "image", data: smallBase64, mimeType: "image/png" }],
				cwd: process.cwd(),
			},
			mockResizer,
		);
		assert.equal(unchanged.changed, false);
		assert.equal(resizerCalled, 0);

		const compressed = await transformImageInput(
			{
				text: "hello",
				images: [{ type: "image", data: bigBase64, mimeType: "image/png" }],
				cwd: process.cwd(),
			},
			mockResizer,
		);
		assert.equal(compressed.changed, true);
		assert.equal(resizerCalled, 1);
		assert.deepEqual(compressed.images, [
			{ type: "image", data: smallBase64, mimeType: "image/jpeg" },
		]);
	});

	test("falls back to original bytes when resizer returns null", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pi-img-compress-fallback-"));
		const orcaPath = path.join(dir, "orca-paste-only.png");
		writeFileSync(orcaPath, TINY_PNG);

		try {
			const res = await transformImageInput(
				{ text: orcaPath, cwd: dir },
				async () => null,
			);
			assert.equal(res.changed, true);
			assert.equal(res.text, `[[image1]](${pathToFileURL(orcaPath).href})`);
			assert.deepEqual(res.images, [
				{ type: "image", data: TINY_PNG.toString("base64"), mimeType: "image/png" },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("extension intercepts pasted/dragged images in terminal input, renders [image1] links, and resolves on submit", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pi-img-compress-tui-"));
		const orcaPath = path.join(dir, "orca-paste-live.png");
		writeFileSync(orcaPath, TINY_PNG);

		const handlers = new Map<string, (event: any, ctx: any) => Promise<any> | any>();
		let terminalListener:
			| ((data: string) => { consume?: boolean; data?: string } | undefined)
			| undefined;
		let editorText = "check ";
		const simulateTuiInput = (raw: string) => {
			const res = terminalListener!(raw);
			const forwarded = res?.data ?? raw;
			if (!res?.consume) {
				editorText += forwarded.replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, "");
			}
			return res;
		};

		imageCompressExtension({
			on(name: string, fn: (event: any, ctx: any) => Promise<any> | any) {
				handlers.set(name, fn);
			},
		} as any);

		const uiCtx = {
			hasUI: true,
			cwd: dir,
			ui: {
				onTerminalInput(fn: (data: string) => { consume?: boolean; data?: string } | undefined) {
					terminalListener = fn;
					return () => {
						terminalListener = undefined;
					};
				},
				getEditorText: () => editorText,
			},
		};

		try {
			assert.deepEqual(extractOrcaPasteFromTerminalInput(`\x1b[200~${orcaPath}\x1b[201~`, dir), {
				path: orcaPath,
				trailingSpace: "",
			});

			handlers.get("session_start")!({}, uiCtx);
			assert.equal(typeof terminalListener, "function");

			const rewritten = simulateTuiInput(`\x1b[200~${orcaPath}\x1b[201~`);
			assert.deepEqual(rewritten, { data: "\x1b[200~[image1]\x1b[201~" });
			assert.equal(editorText, "check [image1]");

			// Deleting `[image1]` from the editor and pasting again reuses `[image1]` and removes the old temp file.
			const orcaPath2 = path.join(dir, "orca-paste-live-2.png");
			writeFileSync(orcaPath2, TINY_PNG);
			editorText = "check ";
			const rewritten2 = simulateTuiInput(`\x1b[200~${orcaPath2}\x1b[201~`);
			assert.deepEqual(rewritten2, { data: "\x1b[200~[image1]\x1b[201~" });
			assert.equal(editorText, "check [image1]");
			assert.equal(existsSync(orcaPath), false);

			// Pasting the exact same image again via a new Orca temp file reuses [image1]
			// and deletes the duplicate temp file immediately.
			const orcaPath3 = path.join(dir, "orca-paste-live-3.png");
			writeFileSync(orcaPath3, TINY_PNG);
			const rewritten3 = simulateTuiInput(`\x1b[200~${orcaPath3}\x1b[201~`);
			assert.deepEqual(rewritten3, { data: "\x1b[200~[image1]\x1b[201~" });
			assert.equal(existsSync(orcaPath3), false);
			editorText = "check [image1]";

			const extRes = await handlers.get("input")!({ source: "extension", text: "hi" }, uiCtx);
			assert.deepEqual(extRes, { action: "continue" });

			const submitRes = await handlers.get("input")!(
				{ source: "interactive", text: editorText },
				uiCtx,
			);
			assert.equal(submitRes.action, "transform");
			assert.equal(submitRes.text, `check [[image1]](${pathToFileURL(orcaPath2).href})`);
			assert.equal(submitRes.images?.length, 1);
			assert.equal(submitRes.images?.[0]?.mimeType, "image/png");
			assert.equal(existsSync(orcaPath2), true);

			// Dragging a local disk image (with escaped spaces) shows [image1] in editor,
			// turns into a clickable [[image1]](file://...) link on submit, and keeps the disk file.
			const localShot = path.join(dir, "My Shot 1.png");
			writeFileSync(localShot, TINY_PNG);
			const escapedLocalShot = localShot.replace(/ /g, "\\ ");
			assert.deepEqual(extractImagePasteFromTerminalInput(`\x1b[200~${escapedLocalShot}\x1b[201~`, dir), {
				path: localShot,
				trailingSpace: "",
			});

			editorText = "check ";
			const localRewritten = simulateTuiInput(`\x1b[200~${escapedLocalShot}\x1b[201~`);
			assert.deepEqual(localRewritten, { data: "\x1b[200~[image1]\x1b[201~" });
			assert.equal(editorText, "check [image1]");

			// Editor line rendering wraps [image1] in an OSC 8 file:// hyperlink while typing.
			const renderedLine = decorateEditorPlaceholders("│ check [image1] │", new Map([["[image1]", localShot]]));
			assert.equal(
				renderedLine,
				`│ check \x1b]8;;${pathToFileURL(localShot).href}\x07\x1b[4m[image1]\x1b[24m\x1b]8;;\x07 │`,
			);

			const localSubmit = await handlers.get("input")!(
				{ source: "interactive", text: editorText },
				uiCtx,
			);
			assert.equal(localSubmit.action, "transform");
			assert.equal(localSubmit.text, `check [[image1]](${pathToFileURL(localShot).href})`);
			assert.equal(localSubmit.images?.length, 1);
			assert.equal(existsSync(localShot), true);
		} finally {
			handlers.get("session_shutdown")?.({}, uiCtx);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("mergeImagePlaceholderSegments collapses active [imageN] placeholders into atomic units", () => {
		const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
		const placeholders = new Map([["[image1]", "/tmp/a.png"]]);
		const text = "see [image1] and [image2]";

		const merged = [...mergeImagePlaceholderSegments(graphemeSegmenter.segment(text), text, placeholders)].map(
			(s) => s.segment,
		);
		assert.deepEqual(merged, [
			"s",
			"e",
			"e",
			" ",
			"[image1]",
			" ",
			"a",
			"n",
			"d",
			" ",
			"[",
			"i",
			"m",
			"a",
			"g",
			"e",
			"2",
			"]",
		]);

		// Empty placeholders map leaves segmentation untouched.
		const plain = [...mergeImagePlaceholderSegments(graphemeSegmenter.segment(text), text, new Map())].map(
			(s) => s.segment,
		);
		assert.ok(!plain.includes("[image1]"));
	});
});
