export const BPP8 = true;

export function buf2img(buf) {
	const img = {};
	let readHead = 0;
	function readBuf32() {
		readHead += 4;
		return buf.readInt32BE(readHead - 4);
	}
	function readBuf16() {
		readHead += 2;
		return buf.readInt16BE(readHead - 2);
	}
	function readBuf8() {
		readHead++;
		return buf.readUInt8(readHead - 1);
	}
	img.width = readBuf16();
	img.height = readBuf16();
	const blockcount = readBuf32();
	img.blocks = [];
	for (let index = 0; index < blockcount; index++) {
		const elem = {};
		elem.nblock4bn = [];
		elem.blockmaxy = readBuf8();
		elem.blockminy = readBuf8();
		elem.blockmaxu = readBuf8();
		elem.blockminu = readBuf8();
		elem.blockmaxv = readBuf8();
		elem.blockminv = readBuf8();
		img.blocks.push(elem);
		elem.interpolatey = readBuf8() == 1;
		elem.interpolateu = readBuf8() == 1;
		elem.interpolatev = readBuf8() == 1;
		elem.corners = [];
		for (let index = 0; index < 4; index++) {
			elem.corners.push([readBuf8(), readBuf8(), readBuf8()]);
		}
	}
	for (let index = 0; index < blockcount; index++) {
		const elem = img.blocks[index];
		for (let i2 = 0; i2 < 8; i2++) {
			elem.nblock4bn.push([]);
			for (let i3 = 0; i3 < 8; i3++) {
				if (BPP8) {
					elem.nblock4bn.at(-1).push(readBuf8());
				} else {
					elem.nblock4bn.at(-1).push(readBuf16());
				}
			}
		}
	}
	return img;
}
export function img2buf(img) {
	const buffer = Buffer.alloc(
		img.blocks.length * (BPP8 ? 64 + 9 + 12 : 128 + 9 + 12) + 8,
	);
	let writeHead = 0;
	function writeBuf32(a) {
		buffer.writeInt32BE(a, writeHead);
		writeHead += 4;
	}
	function writeBuf16(a) {
		buffer.writeInt16BE(a, writeHead);
		writeHead += 2;
	}
	function writeBuf8(a) {
		// if(a>255){
		// 	buffer.writeUInt8(255, writeHead);
		// }else if(a<0){
		// 	buffer.writeUInt8(0, writeHead);
		// }else{
		buffer.writeUInt8(a, writeHead);
		// }
		writeHead++;
	}
	writeBuf16(img.width);
	writeBuf16(img.height);
	writeBuf32(img.blocks.length);
	for (const block of img.blocks) {
		writeBuf8(block.blockmaxy);
		writeBuf8(block.blockminy);
		writeBuf8(block.blockmaxu);
		writeBuf8(block.blockminu);
		writeBuf8(block.blockmaxv);
		writeBuf8(block.blockminv);
		writeBuf8(block.interpolatey ? 1 : 0);
		writeBuf8(block.interpolateu ? 1 : 0);
		writeBuf8(block.interpolatev ? 1 : 0);
		for (const corner of block.corners) {
			writeBuf8(corner[0]);
			writeBuf8(corner[1]);
			writeBuf8(corner[2]);
		}
	}
	for (const block of img.blocks) {
		for (const e1 of block.nblock4bn) {
			for (const element of e1) {
				if (BPP8) {
					writeBuf8(element);
				} else {
					writeBuf16(element);
				}
			}
		}
	}
	return buffer;
}
