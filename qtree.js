import { BPP8, buf2img } from "./binfmt.js";
import fs from "fs/promises";
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
function reconstructImage(block) {
	const nblock = [];
	const {
		nblock4bn,
		blockmaxy,
		blockminy,
		blockmaxu,
		blockminu,
		blockmaxv,
		blockminv,
	} = block;
	let prevpix = [0, 0, 0];
	return nblock4bn.map((row) =>
		row.map((pix) => {
			const oy = Math.floor(pix / (BPP8 ? 16 : 256));
			const ou = Math.floor((pix % (BPP8 ? 16 : 256)) / (BPP8 ? 4 : 16));
			const ov = Math.floor(pix % (BPP8 ? 4 : 16));
			const dy = pixdelta(prevpix[0], oy, 16);
			const du = pixdelta(prevpix[1], ou, 4);
			const dv = pixdelta(prevpix[2], ov, 4);
			prevpix = [dy, du, dv];
			// 正規化された値を元に戻す
			const cy = (dy / (BPP8 ? 15 : 15)) * (blockmaxy - blockminy) + blockminy;
			const cu = (du / (BPP8 ? 3 : 15)) * (blockmaxu - blockminu) + blockminu;
			const cv = (dv / (BPP8 ? 3 : 15)) * (blockmaxv - blockminv) + blockminv;
			return [cy, cu, cv];
		})
	);
}
function cropBlock(block, x, y, wid, hei) {
	const res = Array.from({ length: hei }).fill(
		Array.from({ length: wid }).fill(null)
	);
	for (let iy = 0; iy < hei; iy++) {
		const cy = y + iy;
		for (let ix = 0; ix < wid; ix++) {
			const cx = x + ix;
			if (cy > 7 || cx > 7) {
				throw new Error("oops");
			}
			res[iy][ix] = block[cy][cx];
		}
	}
	return res;
}
function calcAvg(block) {
	return {
		y:
			block
				.map((x) => x.map((y) => y[0]))
				.flat()
				.reduce((a, b) => a + b) / 64,
		u:
			block
				.map((x) => x.map((y) => y[1]))
				.flat()
				.reduce((a, b) => a + b) / 64,
		v:
			block
				.map((x) => x.map((y) => y[2]))
				.flat()
				.reduce((a, b) => a + b) / 64,
	};
}
async function blockToQtree(rblock) {
	const block = reconstructImage(rblock);
	const avgAt = (x, y, w, h) => calcAvg(cropBlock(block, x, y, w, h));
	const toObj = ([y, u, v]) => ({ y, u, v });

	const leaf = (x, y) => ({
		...calcAvg(cropBlock(block, x, y, 2, 2)),
		0: toObj(block[y][x]),
		1: toObj(block[y][x + 1]),
		2: toObj(block[y + 1][x]),
		3: toObj(block[y + 1][x + 1]),
	});

	const qtree = {
		...calcAvg(block),
		0: {
			...avgAt(0, 0, 4, 4),
			0: leaf(0, 0),
			1: leaf(2, 0),
			2: leaf(0, 2),
			3: leaf(2, 2),
		},
		1: {
			...avgAt(4, 0, 4, 4),
			0: leaf(4, 0),
			1: leaf(6, 0),
			2: leaf(4, 2),
			3: leaf(6, 2),
		},
		2: {
			...avgAt(0, 4, 4, 4),
			0: leaf(0, 4),
			1: leaf(2, 4),
			2: leaf(0, 6),
			3: leaf(2, 6),
		},
		3: {
			...avgAt(4, 4, 4, 4),
			0: leaf(4, 4),
			1: leaf(6, 4),
			2: leaf(4, 6),
			3: leaf(6, 6),
		},
	};

	console.log(JSON.stringify(qtree,null,"\t"));
}
blockToQtree(buf2img(await fs.readFile("img.bin")).blocks[0]);
