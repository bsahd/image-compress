use clap::Parser;
use image::{ImageBuffer, Pixel, RgbImage};
use std::fs::File;
use std::io::{self, Read, Write};
use std::path::Path;
mod binfmt;
use crate::binfmt::{Block, Img, buf2img, img2buf};
use image::Rgb;

pub struct ProgressBar {
    pub progress: usize,
    pub max: usize,
    pub title: String,
}

impl ProgressBar {
    pub fn new(max: usize, title: &str) -> Self {
        Self {
            progress: 0,
            max,
            title: title.to_string(),
        }
    }

    pub fn increment(&mut self) {
        self.progress += 1;
        self.render();
    }

    pub fn render(&self) {
        let width = 40;
        let ratio = self.progress as f64 / self.max as f64;
        let complete_chars = (ratio * width as f64).ceil() as usize;
        if width < complete_chars {
            return;
        }
        let incomplete_chars = width - complete_chars;

        let bar = format!(
            "\r{}[{}{}] {}/{}",
            self.title,
            "#".repeat(complete_chars),
            " ".repeat(incomplete_chars),
            self.progress,
            self.max
        );
        let _ = io::stderr().write_all(bar.as_bytes());
        let _ = io::stderr().flush();
    }
}

fn yuv_to_rgb([y, u, v]: [f32; 3]) -> [u8; 3] {
    let r = y + 1.402 * (v - 128.0);
    let g = y - 0.344 * (u - 128.0) - 0.714 * (v - 128.0);
    let b = y + 1.772 * (u - 128.0);
    [
        r.clamp(0.0, 255.0) as u8,
        g.clamp(0.0, 255.0) as u8,
        b.clamp(0.0, 255.0) as u8,
    ]
}

fn pixdelta_decode(prev: u8, del: u8, max: u8) -> u8 {
    (prev + del) % max
}

fn interpolate(tl: f32, tr: f32, bl: f32, br: f32, u: f32, v: f32) -> f32 {
    let top = tl * (1.0 - u) + tr * u;
    let bottom = bl * (1.0 - u) + br * u;
    top * (1.0 - v) + bottom * v
}

fn pad_image_to_multiple_of_8(img: &RgbImage) -> RgbImage {
    let (width, height) = img.dimensions();

    let pad_right = (8 - (width % 8)) % 8;
    let pad_bottom = (8 - (height % 8)) % 8;

    if pad_right == 0 && pad_bottom == 0 {
        return img.clone(); // パディング不要
    }

    let new_width = width + pad_right;
    let new_height = height + pad_bottom;

    let mut padded_img = RgbImage::new(new_width, new_height);

    // 元の画像をコピー
    image::imageops::overlay(&mut padded_img, img, 0, 0);

    padded_img
}

#[derive(Parser)]
struct Args {
    #[arg(short, long, default_value_t = 16)]
    level: u32,
    input: String,
    output: String,
    #[arg(short, long, default_value_t = false)]
    decode: bool,
    #[arg(short, long, default_value_t = false)]
    quiet: bool,
}

// RGB to YUV
fn rgb_to_yuv([r, g, b]: [u8; 3]) -> [f32; 3] {
    let r = r as f32;
    let g = g as f32;
    let b = b as f32;
    let y = 0.299 * r + 0.587 * g + 0.114 * b;
    let u = -0.169 * r - 0.331 * g + 0.5 * b + 128.0;
    let v = 0.5 * r - 0.419 * g - 0.081 * b + 128.0;
    [y, u, v]
}

fn pixdelta(prev: f32, now: f32, max: f32) -> f32 {
    if now >= prev {
        now - prev
    } else {
        max + now - prev
    }
}

fn get_block(img: &ImageBuffer<Rgb<u8>, Vec<u8>>, x0: u32, y0: u32) -> Vec<Vec<[u8; 3]>> {
    let mut block = vec![];
    for y in y0..y0 + 8 {
        let mut row = vec![];
        for x in x0..x0 + 8 {
            let px = img.get_pixel(x, y).channels();
            row.push([px[0], px[1], px[2]]);
        }
        block.push(row);
    }
    block
}

fn get_channel_stats(block: &Vec<Vec<[f32; 3]>>, channel: usize) -> (f32, f32, f32) {
    let mut values = vec![];
    for row in block {
        for px in row {
            values.push(px[channel]);
        }
    }
    let min = values.iter().cloned().fold(f32::INFINITY, f32::min);
    let max = values
        .iter()
        .cloned()
        .fold(f32::NEG_INFINITY, f32::max)
        .min(255.0);
    let range = max - min;
    (min, max, range)
}

fn encode(args: Args) -> Result<(), Box<dyn std::error::Error>> {
    let img = if args.input == "-" {
        let mut buffer = Vec::new();
        io::stdin().read_to_end(&mut buffer)?;
        image::load_from_memory(&buffer)?
    } else {
        image::open(&args.input)?
    };
    let mut rgb = pad_image_to_multiple_of_8(&img.to_rgb8());
    let (mut width, mut height) = rgb.dimensions();

    let pad_right = (8 - width % 8) % 8;
    let pad_bottom = (8 - height % 8) % 8;

    if pad_right > 0 || pad_bottom > 0 {
        let mut padded = ImageBuffer::new(width + pad_right, height + pad_bottom);
        for y in 0..height {
            for x in 0..width {
                let px = rgb.get_pixel(x, y);
                padded.put_pixel(x, y, *px);
            }
        }
        rgb = padded;
        width += pad_right;
        height += pad_bottom;
    }
    let mut pb = ProgressBar::new((width * height / 64) as usize, "encoding...");

    let mut blocks = vec![];
    for y in (0..height).step_by(8) {
        for x in (0..width).step_by(8) {
            let block_rgb = get_block(&rgb, x, y);
            let block_yuv: Vec<Vec<[f32; 3]>> = block_rgb
                .iter()
                .map(|row| row.iter().map(|px| rgb_to_yuv(*px)).collect())
                .collect();

            let (miny, maxy, rangey) = get_channel_stats(&block_yuv, 0);
            let (minu, maxu, rangeu) = get_channel_stats(&block_yuv, 1);
            let (minv, maxv, rangev) = get_channel_stats(&block_yuv, 2);

            let nblock: Vec<Vec<[f32; 3]>> = block_yuv
                .iter()
                .map(|row| {
                    row.iter()
                        .map(|&[y, u, v]| {
                            [
                                if rangey < args.level as f32 / 2.0 {
                                    0.0
                                } else {
                                    (y - miny) / rangey
                                },
                                if rangeu < args.level as f32 {
                                    0.0
                                } else {
                                    (u - minu) / rangeu
                                },
                                if rangev < args.level as f32 {
                                    0.0
                                } else {
                                    (v - minv) / rangev
                                },
                            ]
                        })
                        .collect()
                })
                .collect();

            let mut prev = [0.0, 0.0, 0.0];
            let mut nblock4bn = vec![];
            for row in &nblock {
                let mut row_bin = vec![];
                for &[y, u, v] in row {
                    let qy = (y * 15.9).floor();
                    let qu = (u * 3.9).floor();
                    let qv = (v * 3.9).floor();
                    let d = [
                        pixdelta(prev[0], qy, 16.0),
                        pixdelta(prev[1], qu, 4.0),
                        pixdelta(prev[2], qv, 4.0),
                    ];
                    prev = [qy, qu, qv];
                    row_bin.push((d[0] as u8 * 4 + d[1] as u8) * 4 + d[2] as u8);
                }
                nblock4bn.push(row_bin);
            }

            let corners = [
                block_yuv[0][0],
                block_yuv[0][7],
                block_yuv[7][0],
                block_yuv[7][7],
            ];
            let corners_bin = corners
                .iter()
                .map(|&[y, u, v]| {
                    let qy = if rangey < args.level as f32 / 2.0 {
                        0.0
                    } else {
                        (y - miny) / rangey * 15.9
                    };
                    let qu = if rangeu < args.level as f32 {
                        0.0
                    } else {
                        (u - minu) / rangeu * 3.9
                    };
                    let qv = if rangev < args.level as f32 {
                        0.0
                    } else {
                        (v - minv) / rangev * 3.9
                    };
                    ((qy * 4.0 + qu) * 4.0 + qv) as u8
                })
                .collect();

            blocks.push(Block {
                blockminy: miny as u8,
                blockmaxy: maxy as u8,
                blockminu: minu as u8,
                blockmaxu: maxu as u8,
                blockminv: minv as u8,
                blockmaxv: maxv as u8,
                nblock4bn,
                corners: corners_bin,
                interpolatey: rangey < args.level as f32 / 2.0,
                interpolateu: rangeu < args.level as f32,
                interpolatev: rangev < args.level as f32,
            });
            if !args.quiet {
                pb.increment();
            }
        }
    }
    if !args.quiet {
        eprintln!();
    }
    
    // 出力
    if args.output == "-" {
        io::stdout().write_all(
            img2buf(&Img {
                width: width as i16,
                height: height as i16,
                blocks,
            })
            .as_slice(),
        )?;
    } else {
        let mut f = File::create(&args.output)?;
        f.write_all(
            img2buf(&Img {
                width: width as i16,
                height: height as i16,
                blocks,
            })
            .as_slice(),
        )?;
    }
    Ok(())
}
fn decode(args: Args) -> Result<(), Box<dyn std::error::Error>> {
    let mut buf = Vec::new();
    if args.input == "-" {
        io::stdin().read_to_end(&mut buf)?;
    } else {
        File::open(args.input)?.read_to_end(&mut buf)?;
    };

    let img = buf2img(&buf);
    let mut image = RgbImage::new(img.width as u32, img.height as u32);

    let mut x: i16 = 0;
    let mut y: i16 = 0;
    let mut pb = ProgressBar::new(img.blocks.len(), "decoding...");
    for block in img.blocks {
        let mut prevpix = [0u8; 3];
        let corners = block
            .corners
            .iter()
            .map(|&val| {
                let oy = ((val / 16) as f32 / 15.0) * (block.blockmaxy - block.blockminy) as f32
                    + block.blockminy as f32;
                let ou = (((val % 16) / 4) as f32 / 3.0)
                    * (block.blockmaxu - block.blockminu) as f32
                    + block.blockminu as f32;
                let ov = ((val % 4) as f32 / 3.0) * (block.blockmaxv - block.blockminv) as f32
                    + block.blockminv as f32;
                [oy, ou, ov]
            })
            .collect::<Vec<_>>();

        for by in 0..8 {
            for bx in 0..8 {
                let px = x + bx;
                let py = y + by;
                let encoded = block.nblock4bn[by as usize][bx as usize];

                let oy = encoded / 16;
                let ou = (encoded % 16) / 4;
                let ov = encoded % 4;

                let dy = pixdelta_decode(prevpix[0], oy, 16);
                let du = pixdelta_decode(prevpix[1], ou, 4);
                let dv = pixdelta_decode(prevpix[2], ov, 4);
                prevpix = [dy, du, dv];

                let u = bx as f32 / 7.0;
                let v = by as f32 / 7.0;

                let cy = if block.interpolatey {
                    interpolate(
                        corners[0][0],
                        corners[1][0],
                        corners[2][0],
                        corners[3][0],
                        u,
                        v,
                    )
                } else {
                    (dy as f32 / 15.0) * (block.blockmaxy - block.blockminy) as f32
                        + block.blockminy as f32
                };
                let cu = if block.interpolateu {
                    interpolate(
                        corners[0][1],
                        corners[1][1],
                        corners[2][1],
                        corners[3][1],
                        u,
                        v,
                    )
                } else {
                    (du as f32 / 3.0) * (block.blockmaxu - block.blockminu) as f32
                        + block.blockminu as f32
                };
                let cv = if block.interpolatev {
                    interpolate(
                        corners[0][2],
                        corners[1][2],
                        corners[2][2],
                        corners[3][2],
                        u,
                        v,
                    )
                } else {
                    (dv as f32 / 3.0) * (block.blockmaxv - block.blockminv) as f32
                        + block.blockminv as f32
                };

                let rgb = yuv_to_rgb([cy, cu, cv]);
                if px < img.width && py < img.height {
                    image.put_pixel(px as u32, py as u32, Rgb(rgb));
                }
                if !args.quiet {
                    pb.increment();
                }
            }
        }

        x += 8;
        if x >= img.width {
            x = 0;
            y += 8;
        }
    }
    if !args.quiet {
        eprintln!("")
    }

    image.save(Path::new(&args.output))?;
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    if args.decode {
        decode(args)?;
    } else {
        encode(args)?;
    }

    Ok(())
}
