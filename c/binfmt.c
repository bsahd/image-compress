#include "binfmt.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <winsock2.h>
#else
#include <arpa/inet.h>
#endif

static const char *binfmt_msg =
    "this is binary image of https://github.com/bsahd/image-compress "
    "format.\nversion:"
    "230606ee9a6d0b45b71167f8faa01ed169cd96bb\n\n\n\n\n\n\n\n\n";
static const char *binfmt_endmsg = "\n\n\nthis is binary format. read head "
                                   "using head command for more information.\n";

void img_to_buf(const ImgData *imgdata, char **buffer, size_t *size) {

  size_t total_size = strlen(binfmt_msg) + strlen(binfmt_endmsg) +
                      sizeof(int16_t) * 2 + sizeof(int32_t) +
                      imgdata->block_count * (sizeof(uint8_t) * 7);
  total_size += imgdata->block_count * (sizeof(uint8_t) * 4);
  total_size += imgdata->block_count * (sizeof(uint8_t) * 64);

  char *buf = (char *)malloc(total_size);
  if (!buf) {
    fprintf(stderr, "Memory allocation failed for binfmt buffer.\n");
    *buffer = NULL;
    *size = 0;
    return;
  }
  char *ptr = buf;

  memcpy(ptr, binfmt_msg, strlen(binfmt_msg));
  ptr += strlen(binfmt_msg);

  int16_t width_be = htons(imgdata->width);
  int16_t height_be = htons(imgdata->height);
  memcpy(ptr, &width_be, sizeof(int16_t));
  ptr += sizeof(int16_t);
  memcpy(ptr, &height_be, sizeof(int16_t));
  ptr += sizeof(int16_t);

  int32_t block_count_be = htonl(imgdata->block_count);
  memcpy(ptr, &block_count_be, sizeof(int32_t));
  ptr += sizeof(int32_t);

  for (int i = 0; i < imgdata->block_count; ++i) {

    memcpy(ptr, &imgdata->blocks[i].blockmaxy, sizeof(uint8_t));
    ptr += 1;
    memcpy(ptr, &imgdata->blocks[i].blockminy, sizeof(uint8_t));
    ptr += 1;
    memcpy(ptr, &imgdata->blocks[i].blockmaxu, sizeof(uint8_t));
    ptr += 1;
    memcpy(ptr, &imgdata->blocks[i].blockminu, sizeof(uint8_t));
    ptr += 1;
    memcpy(ptr, &imgdata->blocks[i].blockmaxv, sizeof(uint8_t));
    ptr += 1;
    memcpy(ptr, &imgdata->blocks[i].blockminv, sizeof(uint8_t));
    ptr += 1;

    uint8_t interpolaten = (imgdata->blocks[i].interpolatey << 2) |
                           (imgdata->blocks[i].interpolateu << 1) |
                           imgdata->blocks[i].interpolatev;
    memcpy(ptr, &interpolaten, sizeof(uint8_t));
    ptr += sizeof(uint8_t);
  }

  for (int i = 0; i < imgdata->block_count; ++i) {
    memcpy(ptr, imgdata->blocks[i].corners, sizeof(uint8_t) * 4);
    ptr += sizeof(uint8_t) * 4;
  }

  for (int i = 0; i < imgdata->block_count; ++i) {
    memcpy(ptr, imgdata->blocks[i].nblock4bn, sizeof(uint8_t) * 64);
    ptr += sizeof(uint8_t) * 64;
  }

  memcpy(ptr, binfmt_endmsg, strlen(binfmt_endmsg));
  ptr += strlen(binfmt_endmsg);

  *buffer = buf;
  *size = total_size;
}

ImgData *buf_to_img(const char *buffer, size_t size) {
  const char *ptr = buffer;

  if (size < strlen(binfmt_msg) ||
      memcmp(ptr, binfmt_msg, strlen(binfmt_msg)) != 0) {
    fprintf(stderr, "Invalid header. %s\n", ptr);
    return NULL;
  }
  ptr += strlen(binfmt_msg);

  ImgData *img = (ImgData *)malloc(sizeof(ImgData));
  if (!img) {
    fprintf(stderr, "Memory allocation failed for ImgData.\n");
    return NULL;
  }

  int16_t width_be, height_be;
  memcpy(&width_be, ptr, sizeof(int16_t));
  ptr += sizeof(int16_t);
  memcpy(&height_be, ptr, sizeof(int16_t));
  ptr += sizeof(int16_t);
  img->width = ntohs(width_be);
  img->height = ntohs(height_be);

  int32_t block_count_be;
  memcpy(&block_count_be, ptr, sizeof(int32_t));
  ptr += sizeof(int32_t);
  img->block_count = ntohl(block_count_be);

  img->blocks = (BlockData *)malloc(sizeof(BlockData) * img->block_count);
  if (!img->blocks) {
    fprintf(stderr, "Memory allocation failed for BlockData.\n");
    free(img);
    return NULL;
  }

  for (int i = 0; i < img->block_count; ++i) {
    memcpy(&img->blocks[i].blockmaxy, ptr, sizeof(uint8_t) * 6);
    ptr += sizeof(uint8_t) * 6;
    uint8_t interpolaten;
    memcpy(&interpolaten, ptr, sizeof(uint8_t));
    ptr += sizeof(uint8_t);

    img->blocks[i].interpolatey = (interpolaten >> 2) & 1;
    img->blocks[i].interpolateu = (interpolaten >> 1) & 1;
    img->blocks[i].interpolatev = interpolaten & 1;
  }

  for (int i = 0; i < img->block_count; ++i) {
    memcpy(img->blocks[i].corners, ptr, sizeof(uint8_t) * 4);
    ptr += sizeof(uint8_t) * 4;
  }

  for (int i = 0; i < img->block_count; ++i) {
    memcpy(img->blocks[i].nblock4bn, ptr, sizeof(uint8_t) * 64);
    ptr += sizeof(uint8_t) * 64;
  }

  if (size < (ptr - buffer) + strlen(binfmt_endmsg) ||
      memcmp(ptr, binfmt_endmsg, strlen(binfmt_endmsg)) != 0) {
    fprintf(stderr, "Invalid footer.\n");
    free_imgdata(img);
    return NULL;
  }

  return img;
}

void free_imgdata(ImgData *imgdata) {
  if (imgdata) {
    if (imgdata->blocks) {
      free(imgdata->blocks);
    }
    free(imgdata);
  }
}