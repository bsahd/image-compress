// main.rs または lib.rs
use byteorder::{BigEndian, ReadBytesExt, WriteBytesExt};
use std::io::{Cursor, Read};

const MSG: &[u8] = b"this is binary image of https://github.com/bsahd/image-compress format.\nversion:230606ee9a6d0b45b71167f8faa01ed169cd96bb\n\n\n\n\n\n\n\n\n";
const ENDMSG: &[u8] = b"\n\n\nthis is binary format. read head using head command for more information.\n";

#[derive(Debug)]
pub struct Block {
    pub blockmaxy: u8,
    pub blockminy: u8,
    pub blockmaxu: u8,
    pub blockminu: u8,
    pub blockmaxv: u8,
    pub blockminv: u8,
    pub interpolatey: bool,
    pub interpolateu: bool,
    pub interpolatev: bool,
    pub corners: Vec<u8>,
    pub nblock4bn: Vec<Vec<u8>>,
}

#[derive(Debug)]
pub struct Img {
    pub width: i16,
    pub height: i16,
    pub blocks: Vec<Block>,
}

pub fn buf2img(data: &[u8]) -> Img {
    let mut cursor = Cursor::new(data);

    let mut header = vec![0u8; MSG.len()];
    cursor.read_exact(&mut header).unwrap();
    assert_eq!(&header, MSG);

    let width = cursor.read_i16::<BigEndian>().unwrap();
    let height = cursor.read_i16::<BigEndian>().unwrap();
    let blockcount = cursor.read_i32::<BigEndian>().unwrap();

    let mut blocks = Vec::with_capacity(blockcount as usize);

    for _ in 0..blockcount {
        let blockmaxy = cursor.read_u8().unwrap();
        let blockminy = cursor.read_u8().unwrap();
        let blockmaxu = cursor.read_u8().unwrap();
        let blockminu = cursor.read_u8().unwrap();
        let blockmaxv = cursor.read_u8().unwrap();
        let blockminv = cursor.read_u8().unwrap();
        let interpolate_byte = cursor.read_u8().unwrap();

        blocks.push(Block {
            blockmaxy,
            blockminy,
            blockmaxu,
            blockminu,
            blockmaxv,
            blockminv,
            interpolatey: interpolate_byte >= 4,
            interpolateu: interpolate_byte % 4 >= 2,
            interpolatev: interpolate_byte % 2 == 1,
            corners: Vec::new(),
            nblock4bn: vec![vec![0u8; 8]; 8],
        });
    }

    for block in &mut blocks {
        for _ in 0..4 {
            block.corners.push(cursor.read_u8().unwrap());
        }
    }

    for block in &mut blocks {
        for row in 0..8 {
            for col in 0..8 {
                block.nblock4bn[row][col] = cursor.read_u8().unwrap();
            }
        }
    }

    let mut footer = vec![0u8; ENDMSG.len()];
    cursor.read_exact(&mut footer).unwrap();
    assert_eq!(&footer, ENDMSG);

    Img {
        width,
        height,
        blocks,
    }
}

pub fn img2buf(img: &Img) -> Vec<u8> {
    let mut buffer: Vec<u8> = Vec::with_capacity(
        MSG.len() + ENDMSG.len() + 8 + img.blocks.len() * (7 + 4 + 64),
    );

    buffer.extend_from_slice(MSG);

    buffer.write_i16::<BigEndian>(img.width).unwrap();
    buffer.write_i16::<BigEndian>(img.height).unwrap();
    buffer
        .write_i32::<BigEndian>(img.blocks.len() as i32)
        .unwrap();

    for block in &img.blocks {
        buffer.write_u8(block.blockmaxy).unwrap();
        buffer.write_u8(block.blockminy).unwrap();
        buffer.write_u8(block.blockmaxu).unwrap();
        buffer.write_u8(block.blockminu).unwrap();
        buffer.write_u8(block.blockmaxv).unwrap();
        buffer.write_u8(block.blockminv).unwrap();
        let interp = (if block.interpolatey { 4 } else { 0 })
            + (if block.interpolateu { 2 } else { 0 })
            + (if block.interpolatev { 1 } else { 0 });
        buffer.write_u8(interp).unwrap();
    }

    for block in &img.blocks {
        for &corner in &block.corners {
            buffer.write_u8(corner).unwrap();
        }
    }

    for block in &img.blocks {
        for row in &block.nblock4bn {
            for &val in row {
                buffer.write_u8(val).unwrap();
            }
        }
    }

    buffer.extend_from_slice(ENDMSG);
    buffer
}

