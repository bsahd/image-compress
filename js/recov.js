#!/usr/bin/env node
import sharp from "sharp";
import fs from "fs/promises";
import { buf2img } from "./binfmt.js";
import { ProgressBar } from "./progressbar.js";

function yuvToRgbNorm([Y, U, V]) {
  const R = Y + 1.402 * (V - 128);
  const G = Y - 0.344 * (U - 128) - 0.714 * (V - 128);
  const B = Y + 1.772 * (U - 128);
  return [R, G, B];
}
function pixdelta(prev, del, max) {
  return (prev + del) % max;
}

import { Command } from "commander";
const program = new Command();
program
  .name("bsahd/image-compres")
  .description("a entropy reducer for image.[decode]")
  .argument("<input-file>", 'set "-" to output to stdin')
  .argument("<output-file>", 'set "-" to output to stdout')
  .parse();
if (program.args[0] == "-") {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  var imgbuffer = Buffer.concat(chunks);
} else {
  var buf = await fs.readFile(process.argv[2]);
}

if (process.stdout.isTTY && program.args[1] == "-") {
  console.error("stdout is terminal, aborting");
  process.exit();
}

reconstructImage(
  buf2img(program.args[0] == "-" ? new DataView(imgbuffer.buffer) : new DataView(buf.buffer)),
);
// reconstructImage(JSON.parse(await fs.readFile(process.argv[2])));

// imgdataを元に画像を再構築する関数
async function reconstructImage({ width, height, blocks }) {
  const resultBuffer = Buffer.alloc(width * height * 3);
  const pb = new ProgressBar();
  pb.title = "decoding...";
  pb.max = blocks.length;
  pb.render();
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

      const cornersOrig = corners.map((a) => {
        const oy = (Math.floor(a / 16) / 15) * (blockmaxy - blockminy) + blockminy;
        const ou = (Math.floor((a % 16) / 4) / 3) * (blockmaxu - blockminu) + blockminu;
        const ov = (Math.floor(a % 4) / 3) * (blockmaxv - blockminv) + blockminv;
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
          const u = blockX / 7;
          const v = blockY / 7;

          const interpolate = (tl, tr, bl, br) => {
            const top = tl * (1 - u) + tr * u;
            const bottom = bl * (1 - u) + br * u;
            return top * (1 - v) + bottom * v;
          };

          const cy = interpolatey
            ? interpolate(...cornersOrig.map((a) => a[0]))
            : (dy / 15) * (blockmaxy - blockminy) + blockminy;
          const cu = interpolateu
            ? interpolate(...cornersOrig.map((a) => a[1]))
            : (du / 3) * (blockmaxu - blockminu) + blockminu;
          const cv = interpolatev
            ? interpolate(...cornersOrig.map((a) => a[2]))
            : (dv / 3) * (blockmaxv - blockminv) + blockminv;
          const [r, g, b] = yuvToRgbNorm([cy, cu, cv]);
          const cr = r < 0 ? 0 : r > 255 ? 255 : r;
          const cg = g < 0 ? 0 : g > 255 ? 255 : g;
          const cb = b < 0 ? 0 : b > 255 ? 255 : b;

          const offset = (pixelY * width + pixelX) * 3;
          resultBuffer[offset] = cr;
          resultBuffer[offset + 1] = cg;
          resultBuffer[offset + 2] = cb;
        }
      }
      pb.increment();
    },
  );

  await sharp(resultBuffer, { raw: { width, height, channels: 3 } }).toFile(process.argv[3]);
  process.stderr.write("\n");
}
