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
	const buffer = Buffer.alloc(img.blocks.length * (BPP8 ? 64 + 6 : 128 + 6) + 8);
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
	}
	for (const block of img.blocks) {
		for (const element of block.nblock4bn.flat()) {
			if (BPP8) {
				writeBuf8(element);
			} else {
				writeBuf16(element);
			}
		}
	}
	return buffer;
}
