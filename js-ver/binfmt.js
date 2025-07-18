import assert from "assert";
import { ProgressBar } from "./progressbar.js";

const msg = new TextEncoder().encode(
  "this is binary image of https://github.com/bsahd/image-compress format.\nversion:230606ee9a6d0b45b71167f8faa01ed169cd96bb\n\n\n\n\n\n\n\n\n",
);
const endmsg = new TextEncoder().encode(
  "\n\n\nthis is binary format. read head using head command for more information.\n",
);
export function buf2img(buf) {
  const img = {};
  let readHead = 0;
  function readBuf32() {
    readHead += 4;
    return buf.getInt32(readHead - 4);
  }
  function readBuf16() {
    readHead += 2;
    return buf.getInt16(readHead - 2);
  }
  function readBuf8() {
    readHead++;
    return buf.getUint8(readHead - 1);
  }
  for (let i = 0; i < msg.length; i++) {
    assert(msg[i] == readBuf8());
  }
  img.width = readBuf16();
  img.height = readBuf16();
  const blockcount = readBuf32();
  console.log(img.width, img.height, blockcount);
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
    const interpolaten = readBuf8();
    elem.interpolatey = interpolaten >= 4;
    elem.interpolateu = interpolaten % 4 >= 2;
    elem.interpolatev = interpolaten % 2 == 1;
    elem.corners = [];
  }
  for (let index = 0; index < blockcount; index++) {
    const elem = img.blocks[index];
    for (let index = 0; index < 4; index++) {
      elem.corners.push(readBuf8());
    }
  }
  for (let index = 0; index < blockcount; index++) {
    const elem = img.blocks[index];
    for (let i2 = 0; i2 < 8; i2++) {
      elem.nblock4bn.push([]);
      for (let i3 = 0; i3 < 8; i3++) {
        elem.nblock4bn.at(-1).push(readBuf8());
      }
    }
  }
  for (let i = 0; i < endmsg.length; i++) {
    assert(endmsg[i] == readBuf8());
  }
  return img;
}
export function img2buf(img) {
  const buffer = new DataView(
    new ArrayBuffer(img.blocks.length * (64 + 7 + 4) + 8 + msg.byteLength + endmsg.byteLength),
  );
  let writeHead = 0;
  function writeBuf32(a) {
    buffer.setInt32(writeHead, a);
    writeHead += 4;
  }
  function writeBuf16(a) {
    buffer.setInt16(writeHead, a);
    writeHead += 2;
  }
  function writeBuf8(a) {
    buffer.setUint8(writeHead, a);
    writeHead++;
  }
  for (let i = 0; i < msg.length; i++) {
    writeBuf8(msg[i]);
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
    writeBuf8(
      (block.interpolatey ? 4 : 0) + (block.interpolateu ? 2 : 0) + (block.interpolatev ? 1 : 0),
    );
  }
  for (const block of img.blocks) {
    for (const corner of block.corners) {
      writeBuf8(corner);
    }
  }
  for (const block of img.blocks) {
    for (const e1 of block.nblock4bn) {
      for (const element of e1) {
        writeBuf8(element);
      }
    }
  }
  for (let i = 0; i < endmsg.length; i++) {
    writeBuf8(endmsg[i]);
  }
  return buffer;
}
