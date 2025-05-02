//@ts-check
import sharp from "sharp";
import fs from "fs/promises";
import { buf2img } from "./binfmt.js";

/**
 * convert yuv to rgb
 * @param {[number,number,number]} param0 YUV color
 * @returns {[number,number,number]} RGB color
 */
function yuvToRgbNorm([Y, U, V]) {
	const R = Y + 1.402 * (V - 128);
	const G = Y - 0.344 * (U - 128) - 0.714 * (V - 128);
	const B = Y + 1.772 * (U - 128);
	return [R, G, B];
}
/**
 * calculate pixel from delta
 * @param {number} prev previous quantized pixel
 * @param {number} del delta
 * @param {number} max maximum number
 * @returns {number} current quantized pixel
 */

function pixdelta(prev, del, max) {
	return (prev + del) % max;
}
// imgdataを元に画像を再構築する関数
/**
 * @typedef block
 * @prop {number[][]} nblock4bn
 * @prop {number} blockmaxy
 * @prop {number} blockminy
 * @prop {number} blockmaxu
 * @prop {number} blockminu
 * @prop {number} blockmaxv
 * @prop {number} blockminv
 * @prop {boolean} interpolatey
 * @prop {boolean} interpolateu
 * @prop {boolean} interpolatev
 * @prop {number[]} corners
 */
/**
 *
 * @param {{width:number,height:number,blocks:block[]}} param0
 */
async function reconstructImage({ width, height, blocks }) {
	// 新しい画像用のバッファを作成
	const resultBuffer = Buffer.alloc(width * height * 3);
	let doneb = 0;
	// imgdata から再構築
	let x = -8;
	let y = 0;
	blocks.forEach(
		({
			nblock4bn,
			blockmaxy,
			blockminy,
			blockmaxu,
			blockminu,
			blockmaxv,
			blockminv,
			interpolatey,
			interpolateu,
			interpolatev,
			corners,
		}) => {
			x += 8;
			if (x == width) {
				y += 8;
				x = 0;
			}
			let prevpix = [0, 0, 0];

			const cornersOrig = corners.map((/** @type {number} */ a) => {
				const oy =
					(Math.floor(a / 16) / 15) * (blockmaxy - blockminy) + blockminy;
				const ou =
					(Math.floor((a % 16) / 4) / 3) * (blockmaxu - blockminu) + blockminu;
				const ov =
					(Math.floor(a % 4) / 3) * (blockmaxv - blockminv) + blockminv;
				return [oy, ou, ov];
			});
			for (let blockY = 0; blockY < 8; blockY++) {
				for (let blockX = 0; blockX < 8; blockX++) {
					const pixelX = x + blockX;
					const pixelY = y + blockY;
					const oy = Math.floor(nblock4bn[blockY][blockX] / 16);
					const ou = Math.floor((nblock4bn[blockY][blockX] % 16) / 4);
					const ov = Math.floor(nblock4bn[blockY][blockX] % 4);
					const dy = pixdelta(prevpix[0], oy, 16);
					const du = pixdelta(prevpix[1], ou, 4);
					const dv = pixdelta(prevpix[2], ov, 4);
					prevpix = [dy, du, dv];
					// 正規化された値を元に戻す
					const u = blockX / 7;
					const v = blockY / 7;

					const interpolate = (
						/** @type {number} */ tl,
						/** @type {number} */ tr,
						/** @type {number} */ bl,
						/** @type {number} */ br
					) => {
						const top = tl * (1 - u) + tr * u;
						const bottom = bl * (1 - u) + br * u;
						return top * (1 - v) + bottom * v;
					};

					const cy = interpolatey
						? interpolate(...cornersOrig.map((/** @type {any[]} */ a) => a[0]))
						: (dy / 15) * (blockmaxy - blockminy) + blockminy;
					const cu = interpolateu
						? interpolate(...cornersOrig.map((/** @type {any[]} */ a) => a[1]))
						: (du / 3) * (blockmaxu - blockminu) + blockminu;
					const cv = interpolatev
						? interpolate(...cornersOrig.map((/** @type {any[]} */ a) => a[2]))
						: (dv / 3) * (blockmaxv - blockminv) + blockminv;
					const [r, g, b] = yuvToRgbNorm([cy, cu, cv]);
					const cr = r < 0 ? 0 : r > 255 ? 255 : r;
					const cg = g < 0 ? 0 : g > 255 ? 255 : g;
					const cb = b < 0 ? 0 : b > 255 ? 255 : b;

					// 画像のバッファに書き込む
					const offset = (pixelY * width + pixelX) * 3;
					resultBuffer[offset] = cr;
					resultBuffer[offset + 1] = cg;
					resultBuffer[offset + 2] = cb;
				}
			}
			doneb++;
			process.stdout.write(
				new TextEncoder().encode(
					`\rprocessing... ${doneb
						.toString()
						.padStart(blocks.length.toString().length)}/${blocks.length}block`
				)
			);
		}
	);

	// 新しい画像を保存
	await sharp(resultBuffer, { raw: { width, height, channels: 3 } }).toFile(
		process.argv[3]
	);
	console.log("画像が再構築されました。");
}

const buf = await fs.readFile(process.argv[2]);
reconstructImage(buf2img(new DataView(buf.buffer)));
// reconstructImage(JSON.parse(await fs.readFile(process.argv[2])));
