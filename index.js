#!/usr/bin/env node
import sharp from "sharp";
import fs from "fs/promises";
import { img2buf } from "./binfmt.js";
import { ProgressBar } from "./progressbar.js";
import { Command } from "commander";
const program = new Command();
program
	.name("bsahd/image-compres")
	.description("a entropy reducer for image.")
	.option("-l, --level <compress-level>", "set compression level.", "16")
	.argument("<input-file>", 'set "-" to output to stdin')
	.argument("<output-file>", 'set "-" to output to stdout')
	.parse();

if (process.stdout.isTTY && program.args[1] == "-") {
	console.error("stdout is terminal, aborting");
	process.exit();
}
function rgbToYuvNorm([r, g, b]) {
	const Y = 0.299 * r + 0.587 * g + 0.114 * b;
	const U = -0.169 * r - 0.331 * g + 0.5 * b + 128;
	const V = 0.5 * r - 0.419 * g - 0.081 * b + 128;
	return [Y, U, V];
}

function pixdelta(prev, now, max) {
	if (now >= prev) {
		return now - prev;
	} else {
		return max + now - prev;
	}
}
const COMPRESS_LEVEL = parseInt(program.opts().level);

async function processImage(imagePath) {
	try {
		if (imagePath == "-") {
			const chunks = [];
			for await (const chunk of process.stdin) {
				chunks.push(chunk);
			}

			var imgbuffer = Buffer.concat(chunks);
		}
		let image = sharp(imagePath == "-" ? imgbuffer : imagePath);

		const metadata = await image.metadata();
		if (!(metadata.width && metadata.height)) {
			throw new Error("no width/height in metadata");
		}

		let width = metadata.width;
		let height = metadata.height;

		const padRight = (8 - (width % 8)) % 8;
		const padBottom = (8 - (height % 8)) % 8;

		if (padRight || padBottom) {
			image = image.extend({
				right: padRight,
				bottom: padBottom,
				background: { r: 0, g: 0, b: 0 },
			});
			width += padRight;
			height += padBottom;
			console.log("extended", width, height);
		}
		const imgdata = {
			width,
			height,
			blocks: [],
		};
		const rawData = await image.raw().removeAlpha().toBuffer();
		const pb = new ProgressBar();
		pb.title = "encoding...";
		pb.max = (width * height) / 64 + 1;
		pb.render();
		for (let y = 0; y < height; y += 8) {
			for (let x = 0; x < width; x += 8) {
				const block = getBlock(rawData, width, x, y, 8, 8);
				const blockyuv = block.map((x) => x.map((y) => rgbToYuvNorm(y)));
				const getChannelStats = (block, channel) => {
					const values = block.flatMap((row) => row.map((px) => px[channel]));
					let max = Math.ceil(Math.max(...values));
					if (max === 256) max = 255;
					const min = Math.floor(Math.min(...values));
					const drange = max - min;
					return [min, max, drange];
				};

				const [blockminy, blockmaxy, blockdrangey] = getChannelStats(
					blockyuv,
					0
				);
				const [blockminu, blockmaxu, blockdrangeu] = getChannelStats(
					blockyuv,
					1
				);
				const [blockminv, blockmaxv, blockdrangev] = getChannelStats(
					blockyuv,
					2
				);
				const nblock = blockyuv.map((x, yi) =>
					x.map(([cy, cu, cv], xi) => [
						blockdrangey < COMPRESS_LEVEL / 2
							? 0
							: (cy - blockminy) / blockdrangey,
						blockdrangeu < COMPRESS_LEVEL ? 0 : (cu - blockminu) / blockdrangeu,
						blockdrangev < COMPRESS_LEVEL ? 0 : (cv - blockminv) / blockdrangev,
					])
				);
				let prevpix = [0, 0, 0];
				const nblock4b = nblock.map((tileline, y) => {
					return tileline.map(([cy, cu, cv], x) => {
						const qy = Math.floor(cy * 15.9);
						const qu = Math.floor(cu * 3.9);
						const qv = Math.floor(cv * 3.9);
						const res = [qy, qu, qv];
						const resd = [
							pixdelta(prevpix[0], qy, 16),
							pixdelta(prevpix[1], qu, 4),
							pixdelta(prevpix[2], qv, 4),
						];
						prevpix = res;
						return resd;
					});
				});
				const nblock4bn = nblock4b.map((x) =>
					x.map(([r, g, b]) => (r * 4 + g) * 4 + b)
				);
				const corners = [
					blockyuv[0][0],
					blockyuv[0][7],
					blockyuv[7][0],
					blockyuv[7][7],
				]
					.map(([cy, cu, cv]) => [
						(cy - blockminy) / blockdrangey,
						(cu - blockminu) / blockdrangeu,
						(cv - blockminv) / blockdrangev,
					])
					.map(([cy, cu, cv], y) => {
						const qy =
							blockdrangey < COMPRESS_LEVEL / 2 ? Math.floor(cy * 15.9) : 0;
						const qu = blockdrangeu < COMPRESS_LEVEL ? Math.floor(cu * 3.9) : 0;
						const qv = blockdrangev < COMPRESS_LEVEL ? Math.floor(cv * 3.9) : 0;
						const res = [qy, qu, qv];
						return res;
					})
					.map(([r, g, b]) => (r * 4 + g) * 4 + b);
				if (nblock4bn.flat().some((a) => a > 255)) {
					console.log(nblock4b);
					throw new Error(`Overflow detected at block (${x},${y})`);
				}
				imgdata.blocks.push({
					blockmaxy,
					blockminy,
					blockmaxu,
					blockminu,
					blockmaxv,
					blockminv,
					nblock4bn,
					interpolatey: blockdrangey < COMPRESS_LEVEL / 2,
					interpolateu: blockdrangeu < COMPRESS_LEVEL,
					interpolatev: blockdrangev < COMPRESS_LEVEL,
					corners,
				});
				pb.increment();
			}
		}
		if (program.args[1] == "-") {
			process.stdout.write(img2buf(imgdata));
		} else {
			await fs.writeFile(program.args[1], img2buf(imgdata));
		}
		pb.increment();
		process.stderr.write("\n");
		// await fs.writeFile(process.argv[3], JSON.stringify(imgdata));
	} catch (error) {
		console.error("画像の処理中にエラーが発生しました:", error);
	}
}

function getBlock(rawData, width, startX, startY, blockWidth, blockHeight) {
	/** @type {[number,number,number][][]} */
	const result = [];
	for (let y = startY; y < startY + blockHeight; y++) {
		result.push([]);
		for (let x = startX; x < startX + blockWidth; x++) {
			const offset = (y * width + x) * 3;
			const r = rawData[offset];
			const g = rawData[offset + 1];
			const b = rawData[offset + 2];
			result.at(-1)?.push([r, g, b]);
		}
	}
	return result;
}

processImage(program.args[0]);
