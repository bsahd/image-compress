//@ts-check
import sharp from "sharp";
import fs from "fs/promises";
import { BPP8, img2buf } from "./binfmt.js";

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
const COMPRESS_LEVEL = parseInt(process.argv[4]);

async function processImage(imagePath) {
	try {
		// 画像を読み込む
		let image = sharp(imagePath);

		// 画像のメタデータを取得（幅と高さを知りたい）
		const metadata = await image.metadata();
		if (!(metadata.width && metadata.height)) {
			throw new Error("no width/height in metadata");
		}

		let width = metadata.width;
		let height = metadata.height;

		// 8の倍数に丸める
		const padRight = (8 - (width % 8)) % 8;
		const padBottom = (8 - (height % 8)) % 8;

		// 必要ならパディング
		if (padRight || padBottom) {
			image = image.extend({
				right: padRight,
				bottom: padBottom,
				background: { r: 0, g: 0, b: 0 }, // 黒パディング
			});
			width += padRight;
			height += padBottom;
			console.log("extended", width, height);
		}
		/** @type {{width:number,height:number,blocks:{nblock4bn:number[][],blockmaxy:number,blockminy:number,blockmaxu:number,blockminu:number,blockmaxv:number,blockminv:number}[]}} */
		const imgdata = {
			width,
			height,
			blocks: [],
		};

		// 画像のピクセルデータを取得
		const rawData = await image.raw().removeAlpha().toBuffer();
		console.log(`total ${(width * height) / 64} blocks`);
		let doneb = 0;
		const blockcount = (width * height) / 64;
		// 画像のピクセルデータを8x8ブロックごとに処理
		for (let y = 0; y < height; y += 8) {
			for (let x = 0; x < width; x += 8) {
				// 8x8の範囲を取り出して処理
				const block = getBlock(rawData, width, x, y, 8, 8);
				const blockyuv = block.map((x) => x.map((y) => rgbToYuvNorm(y)));
				const getChannelStats = (block, channel) => {
					const values = block.flatMap(row => row.map(px => px[channel]));
					let max = Math.ceil(Math.max(...values));
					if (max === 256) max = 255;
					const min = Math.floor(Math.min(...values));
					const drange = max - min;
					return [min, max, drange];
				};

				const [blockminy, blockmaxy, blockdrangey] = getChannelStats(blockyuv, 0);
				const [blockminu, blockmaxu, blockdrangeu] = getChannelStats(blockyuv, 1);
				const [blockminv, blockmaxv, blockdrangev] = getChannelStats(blockyuv, 2);
				const nblock = blockyuv.map((x, yi) =>
					x.map(([cy, cu, cv], xi) => {
						const u = xi / 7;
						const v = yi / 7;

						const interpolate = (tl, tr, bl, br) => {
							const top = tl * (1 - u) + tr * u;
							const bottom = bl * (1 - u) + br * u;
							return top * (1 - v) + bottom * v;
						};

						const yGrad = interpolate(
							blockyuv[0][0][0], blockyuv[0][7][0],
							blockyuv[7][0][0], blockyuv[7][7][0]
						);
						const uGrad = interpolate(
							blockyuv[0][0][1], blockyuv[0][7][1],
							blockyuv[7][0][1], blockyuv[7][7][1]
						);
						const vGrad = interpolate(
							blockyuv[0][0][2], blockyuv[0][7][2],
							blockyuv[7][0][2], blockyuv[7][7][2]
						);

						return [
							blockdrangey < COMPRESS_LEVEL / 2
							? (yGrad - blockminy) / blockdrangey
							: (cy - blockminy) / blockdrangey,
						  blockdrangeu < COMPRESS_LEVEL
						  ? (uGrad - blockminu) / blockdrangeu
						  : (cu - blockminu) / blockdrangeu,
						  blockdrangev < COMPRESS_LEVEL
						  ? (vGrad - blockminv) / blockdrangev
						  : (cv - blockminv) / blockdrangev,
						];
					}),
				);
				/** @type {number[]} */
				let prevpix = [0, 0, 0];
				const nblock4b = nblock.map((tileline, y) => {
					return tileline.map(([cy, cu, cv], x) => {
						const qy = Math.floor(cy * (BPP8 ? 15.9 : 15.9));
						const qu = Math.floor(cu * (BPP8 ? 3.9 : 15.9));
						const qv = Math.floor(cv * (BPP8 ? 3.9 : 15.9));
						const res = [qy, qu, qv];
						const resd = [
							pixdelta(prevpix[0], qy, 16),
							pixdelta(prevpix[1], qu, BPP8 ? 4 : 16),
							pixdelta(prevpix[2], qv, BPP8 ? 4 : 16),
						];
						prevpix = res;
						return resd;
					});
				});
				const nblock4bn = nblock4b.map((x) =>
					x.map(([r, g, b]) => (r * (BPP8 ? 4 : 16) + g) * (BPP8 ? 4 : 16) + b),
				);
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
				});
				doneb++;
				process.stdout.write(
					new TextEncoder().encode(
						`\rprocessing... ${doneb
							.toString()
							.padStart(blockcount.toString().length)}/${blockcount}block`,
					),
				);
			}
		}
		console.log("\ndone. writing...");
		await fs.writeFile(process.argv[3], img2buf(imgdata));
		// await fs.writeFile(process.argv[3], JSON.stringify(imgdata));
	} catch (error) {
		console.error("画像の処理中にエラーが発生しました:", error);
	}
}

// 8x8ブロックの処理
function getBlock(rawData, width, startX, startY, blockWidth, blockHeight) {
	/** @type {[number,number,number][][]} */
	const result = [];
	// ブロックのピクセルデータを取得
	for (let y = startY; y < startY + blockHeight; y++) {
		result.push([]);
		for (let x = startX; x < startX + blockWidth; x++) {
			const offset = (y * width + x) * 3; // RGB値なので、3つのチャネル
			const r = rawData[offset]; // 赤
			const g = rawData[offset + 1]; // 緑
			const b = rawData[offset + 2]; // 青
			result.at(-1)?.push([r, g, b]);

			// ここで、r, g, bを使って任意の処理を行う
			// 例: 色を変更したい場合、r, g, bを変更して新しい色を設定することができます
		}
	}
	return result;
}

// 画像を処理
processImage(process.argv[2]);
