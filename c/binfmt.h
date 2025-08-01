#ifndef BINFMT_H
#define BINFMT_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
  uint8_t blockmaxy, blockminy;
  uint8_t blockmaxu, blockminu;
  uint8_t blockmaxv, blockminv;
  bool interpolatey, interpolateu, interpolatev;
  uint8_t corners[4];
  uint8_t nblock4bn[8][8];
} BlockData;

typedef struct {
  int16_t width, height;
  int32_t block_count;
  BlockData *blocks;
} ImgData;

/**
 * @brief ImgData構造体からバイナリバッファを生成する
 */
void img_to_buf(const ImgData *imgdata, char **buffer, size_t *size);

/**
 * @brief バイナリバッファからImgData構造体を復元する
 * @param buffer 入力バイナリバッファ
 * @param size 入力バイナリバッファのサイズ
 * @return 復元されたImgData構造体へのポインタ、失敗した場合はNULL
 */
ImgData *buf_to_img(const char *buffer, size_t size);

/**
 * @brief ImgData構造体のメモリを解放する
 * @param imgdata 解放する構造体へのポインタ
 */
void free_imgdata(ImgData *imgdata);

#endif