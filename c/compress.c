#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <vips/vips.h>

#ifdef _WIN32
#include <winsock2.h>
#else
#include <arpa/inet.h>
#endif

#include "binfmt.h"

#define COMPRESS_LEVEL 16

typedef struct {
  double y, u, v;
} YUV_Pixel;

void rgb_to_yuv_norm(uint8_t r, uint8_t g, uint8_t b, YUV_Pixel *yuv) {
  yuv->y = 0.299 * r + 0.587 * g + 0.114 * b;
  yuv->u = -0.169 * r - 0.331 * g + 0.5 * b + 128;
  yuv->v = 0.5 * r - 0.419 * g - 0.081 * b + 128;
}

int pix_delta(int prev, int now, int max) {
  if (now >= prev) {
    return now - prev;
  } else {
    return max + now - prev;
  }
}

void get_channel_stats(YUV_Pixel block[8][8], float channel, uint8_t *min_val,
                       uint8_t *max_val, int *drange) {
  double min_d = 256.0, max_d = -1.0;
  for (int by = 0; by < 8; by++) {
    for (int bx = 0; bx < 8; bx++) {
      double val;
      if (channel == 0)
        val = block[by][bx].y;
      else if (channel == 1)
        val = block[by][bx].u;
      else
        val = block[by][bx].v;
      min_d = fmin(min_d, val);
      max_d = fmax(max_d, val);
    }
  }
  *max_val = ceil(max_d);
  *min_val = floor(min_d);
  *drange = *max_val - *min_val;
}

int main(int argc, char *argv[]) {
  if (VIPS_INIT(argv[0])) {
    vips_error_exit(NULL);
  }

#ifdef _WIN32
  WSADATA wsaData;
  if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0) {
    fprintf(stderr, "WSAStartup failed.\n");
    return 1;
  }
#endif

  if (argc < 3) {
    fprintf(stderr, "Usage: %s [compress_level] <input_file> <output_file>\n",
            argv[0]);
    return 1;
  }

  int compress_level = (argc > 3) ? atoi(argv[1]) : COMPRESS_LEVEL;
  const char *input_file = (argc > 3) ? argv[2] : argv[1];
  const char *output_file = (argc > 3) ? argv[3] : argv[2];

  VipsImage *image;
  if (strcmp(input_file, "-") == 0) {
    fprintf(stderr, "Reading from stdin is not supported in this C version.\n");
    return 1;
  } else {
    if (!(image = vips_image_new_from_file(input_file, NULL))) {
      vips_error_exit(NULL);
    }
  }

  int width = vips_image_get_width(image);
  int height = vips_image_get_height(image);
  int bands = vips_image_get_bands(image);

  if (bands == 4) {
    fprintf(stderr, "Alpha channel detected, extracting RGB bands.\n");
    VipsImage *temp;
    if (vips_extract_band(image, &temp, 0, "n", 3, NULL) != 0) {
      vips_error_exit(NULL);
    }
    g_object_unref(image);
    image = temp;
    bands = vips_image_get_bands(image);
  }

  int pad_right = (8 - (width % 8)) % 8;
  int pad_bottom = (8 - (height % 8)) % 8;

  if (pad_right > 0 || pad_bottom > 0) {
    VipsImage *temp;
    if (vips_embed(image, &temp, 0, 0, width + pad_right, height + pad_bottom,
                   "extend", VIPS_EXTEND_BLACK, NULL) != 0) {
      vips_error_exit(NULL);
    }
    g_object_unref(image);
    image = temp;
    width = vips_image_get_width(image);
    height = vips_image_get_height(image);
    fprintf(stderr, "Extended to %dx%d\n", width, height);
  }

  VipsImage *image_uchar;
  if (vips_cast(image, &image_uchar, VIPS_FORMAT_UCHAR, NULL) != 0) {
    vips_error_exit(NULL);
  }
  g_object_unref(image);
  image = image_uchar;

  size_t image_size;
  void *pixels_void;
  pixels_void = vips_image_write_to_memory(image, &image_size);
  if (!pixels_void) {
    vips_error_exit(NULL);
  }
  uint8_t *pixels = (uint8_t *)pixels_void;

  ImgData imgdata;
  imgdata.width = width;
  imgdata.height = height;
  imgdata.block_count = (width / 8) * (height / 8);
  imgdata.blocks =
      (BlockData *)g_malloc(sizeof(BlockData) * imgdata.block_count);
  if (!imgdata.blocks) {
    fprintf(stderr, "Memory allocation failed for imgdata.blocks.\n");
    g_free(pixels);
    return 1;
  }
  size_t block_index = 0;

  fprintf(stderr, "Encoding...\n");
  for (int y = 0; y < height; y += 8) {
    for (int x = 0; x < width; x += 8) {
      YUV_Pixel block_yuv[8][8];
      for (int by = 0; by < 8; by++) {
        for (int bx = 0; bx < 8; bx++) {
          size_t offset = ((y + by) * width + (x + bx)) * 3;
          uint8_t r = pixels[offset];
          uint8_t g = pixels[offset + 1];
          uint8_t b = pixels[offset + 2];
          rgb_to_yuv_norm(r, g, b, &block_yuv[by][bx]);
        }
      }

      BlockData *current_block = &imgdata.blocks[block_index++];
      int drangey, drangeu, drangev;

      get_channel_stats(block_yuv, 0, &current_block->blockminy,
                        &current_block->blockmaxy, &drangey);
      get_channel_stats(block_yuv, 1, &current_block->blockminu,
                        &current_block->blockmaxu, &drangeu);
      get_channel_stats(block_yuv, 2, &current_block->blockminv,
                        &current_block->blockmaxv, &drangev);

      current_block->interpolatey = (drangey < compress_level / 2);
      current_block->interpolateu = (drangeu < compress_level);
      current_block->interpolatev = (drangev < compress_level);

      YUV_Pixel prevpix = {0, 0, 0};

      for (int yi = 0; yi < 8; yi++) {
        for (int xi = 0; xi < 8; xi++) {
          double cy = block_yuv[yi][xi].y;
          double cu = block_yuv[yi][xi].u;
          double cv = block_yuv[yi][xi].v;

          int qy, qu, qv;
          if (current_block->interpolatey) {
            qy = 0;
          } else {
            qy = floor((cy - current_block->blockminy) / drangey * 15.9);
          }
          if (current_block->interpolateu) {
            qu = 0;
          } else {
            qu = floor((cu - current_block->blockminu) / drangeu * 3.9);
          }
          if (current_block->interpolatev) {
            qv = 0;
          } else {
            qv = floor((cv - current_block->blockminv) / drangev * 3.9);
          }

          int r_delta = pix_delta((int)prevpix.y, qy, 16);
          int g_delta = pix_delta((int)prevpix.u, qu, 4);
          int b_delta = pix_delta((int)prevpix.v, qv, 4);
          current_block->nblock4bn[yi][xi] =
              (r_delta * 4 + g_delta) * 4 + b_delta;

          prevpix.y = qy;
          prevpix.u = qu;
          prevpix.v = qv;
        }
      }

      int corners_indices[4][2] = {{0, 0}, {0, 7}, {7, 0}, {7, 7}};
      for (int i = 0; i < 4; i++) {
        int yi = corners_indices[i][0];
        int xi = corners_indices[i][1];
        double cy = block_yuv[yi][xi].y;
        double cu = block_yuv[yi][xi].u;
        double cv = block_yuv[yi][xi].v;

        int qy, qu, qv;
        if (current_block->interpolatey) {
          qy = floor(cy / 255.0 * 15.9);
        } else {
          qy = (drangey > 0)
                   ? floor((cy - current_block->blockminy) / drangey * 15.9)
                   : 0;
        }
        if (current_block->interpolateu) {
          qu = floor(cu / 255.0 * 3.9);
        } else {
          qu = (drangeu > 0)
                   ? floor((cu - current_block->blockminu) / drangeu * 3.9)
                   : 0;
        }
        if (current_block->interpolatev) {
          qv = floor(cv / 255.0 * 3.9);
        } else {
          qv = (drangev > 0)
                   ? floor((cv - current_block->blockminv) / drangev * 3.9)
                   : 0;
        }
        current_block->corners[i] = (qy * 4 + qu) * 4 + qv;
      }
    }
  }
  g_free(pixels);

  char *compressed_data = NULL;
  size_t compressed_size = 0;
  img_to_buf(&imgdata, &compressed_data, &compressed_size);

  if (strcmp(output_file, "-") == 0) {
    fwrite(compressed_data, 1, compressed_size, stdout);
  } else {
    FILE *out_file = fopen(output_file, "wb");
    if (!out_file) {
      fprintf(stderr, "Could not open output file: %s\n", output_file);
      g_free(compressed_data);
      g_free(imgdata.blocks);
#ifdef _WIN32
      WSACleanup();
#endif
      return 1;
    }
    fwrite(compressed_data, 1, compressed_size, out_file);
    fclose(out_file);
  }

  g_free(compressed_data);
  g_free(imgdata.blocks);
  vips_shutdown();

#ifdef _WIN32
  WSACleanup();
#endif
  fprintf(stderr, "Done.\n");
  return 0;
}
