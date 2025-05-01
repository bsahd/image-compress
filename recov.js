import sharp from "sharp";
import fs from "fs/promises";
import { BPP8, buf2img } from "./binfmt.js";

function yuvToRgbNorm([Y, U, V]) {
	const R = Y + 1.402 * (V - 128);
	const G = Y - 0.344 * (U - 128) - 0.714 * (V - 128);
	const B = Y + 1.772 * (U - 128);
	return [R, G, B];
}
function pixdelta(prev, del, max) {
	return (prev + del) % max;
}
// imgdataを元に画像を再構築する関数
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
			for (let blockY = 0; blockY < 8; blockY++) {
				for (let blockX = 0; blockX < 8; blockX++) {
					const pixelX = x + blockX;
					const pixelY = y + blockY;
					const oy = Math.floor(nblock4bn[blockY][blockX] / (BPP8 ? 16 : 256));
					const ou = Math.floor(
						(nblock4bn[blockY][blockX] % (BPP8 ? 16 : 256)) / (BPP8 ? 4 : 16),
					);
					const ov = Math.floor(nblock4bn[blockY][blockX] % (BPP8 ? 4 : 16));
					const dy = pixdelta(prevpix[0], oy, 16);
					const du = pixdelta(prevpix[1], ou, 4);
					const dv = pixdelta(prevpix[2], ov, 4);
					prevpix = [dy, du, dv];
					// 正規化された値を元に戻す
					const u = blockX / 7;
					const v = blockY / 7;

					const interpolate = (tl, tr, bl, br) => {
						const top = tl * (1 - u) + tr * u;
						const bottom = bl * (1 - u) + br * u;
						return top * (1 - v) + bottom * v;
					};

					const cy =interpolatey?interpolate(...corners.map(a=>a[0])):
						(dy / (BPP8 ? 15 : 15)) * (blockmaxy - blockminy) + blockminy;
					const cu =interpolateu?interpolate(...corners.map(a=>a[1])):
						(du / (BPP8 ? 3 : 15)) * (blockmaxu - blockminu) + blockminu;
					const cv =interpolatev?interpolate(...corners.map(a=>a[2])):
						(dv / (BPP8 ? 3 : 15)) * (blockmaxv - blockminv) + blockminv;
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
						.padStart(blocks.length.toString().length)}/${blocks.length}block`,
				),
			);
		},
	);

	// 新しい画像を保存
	await sharp(resultBuffer, { raw: { width, height, channels: 3 } }).toFile(
		process.argv[3],
	);
	console.log("画像が再構築されました。");
}

reconstructImage(buf2img(await fs.readFile(process.argv[2])));
// reconstructImage(JSON.parse(await fs.readFile(process.argv[2])));
