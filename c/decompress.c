#include "binfmt.h"
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

typedef struct {
  double r, g, b;
} RGB_Pixel;

RGB_Pixel yuv_to_rgb_norm(double Y, double U, double V);
int pix_delta_rev(int prev, int delta, int max);
double interpolate(double tl, double tr, double bl, double br, double u,
                   double v);

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
    fprintf(stderr, "Usage: %s <input_file> <output_file>\n", argv[0]);
    return 1;
  }

  const char *input_file = argv[1];
  const char *output_file = argv[2];

  char *data = NULL;
  size_t data_size = 0;

  if (strcmp(input_file, "-") == 0) {
    fprintf(stderr, "Reading from stdin is not supported in this C version.\n");
    return 1;
  } else {
    FILE *in_file = fopen(input_file, "rb");
    if (!in_file) {
      fprintf(stderr, "Could not open input file: %s\n", input_file);
      return 1;
    }
    fseek(in_file, 0, SEEK_END);
    data_size = ftell(in_file);
    fseek(in_file, 0, SEEK_SET);
    data = (char *)malloc(data_size);
    if (!data) {
      fprintf(stderr, "Memory allocation failed for input buffer.\n");
      fclose(in_file);
      return 1;
    }
    fread(data, 1, data_size, in_file);
    fclose(in_file);
  }

  ImgData *imgdata = buf_to_img(data, data_size);
  if (!imgdata) {
    fprintf(stderr, "Failed to decode image data.\n");
    free(data);
    return 1;
  }
  free(data);

  int width = imgdata->width;
  int height = imgdata->height;

  void *pixel_data_ptr;
  size_t pixel_data_size = width * height * 3;
  if (!(pixel_data_ptr = g_malloc(pixel_data_size))) {
    fprintf(stderr, "Failed to allocate memory for pixel data.\n");
    free_imgdata(imgdata);
    return 1;
  }

  fprintf(stderr, "Decoding...\n");
  int current_x = -8;
  int current_y = 0;

  for (int i = 0; i < imgdata->block_count; ++i) {
    BlockData *block = &imgdata->blocks[i];

    current_x += 8;
    if (current_x >= width) {
      current_y += 8;
      current_x = 0;
    }

    double corners_orig[4][3];
    for (int j = 0; j < 4; ++j) {
      uint8_t corner = block->corners[j];
      double oy = (floor(corner / 16.0) / 15.0) *
                      (block->blockmaxy - block->blockminy) +
                  block->blockminy;
      double ou = (floor((corner % 16) / 4.0) / 3.0) *
                      (block->blockmaxu - block->blockminu) +
                  block->blockminu;
      double ov =
          (floor(corner % 4) / 3.0) * (block->blockmaxv - block->blockminv) +
          block->blockminv;
      corners_orig[j][0] = oy;
      corners_orig[j][1] = ou;
      corners_orig[j][2] = ov;
    }

    double prevpix[3] = {0, 0, 0};
    for (int blockY = 0; blockY < 8; ++blockY) {
      for (int blockX = 0; blockX < 8; ++blockX) {
        uint8_t nblock_val = block->nblock4bn[blockY][blockX];
        int oy_val = floor(nblock_val / 16.0);
        int ou_val = floor((nblock_val % 16) / 4.0);
        int ov_val = floor(nblock_val % 4);

        double dy = pix_delta_rev((int)prevpix[0], oy_val, 16);
        double du = pix_delta_rev((int)prevpix[1], ou_val, 4);
        double dv = pix_delta_rev((int)prevpix[2], ov_val, 4);
        prevpix[0] = dy;
        prevpix[1] = du;
        prevpix[2] = dv;

        double u_interp = (double)blockX / 7.0;
        double v_interp = (double)blockY / 7.0;

        double cy, cu, cv;
        if (block->interpolatey) {
          cy = interpolate(corners_orig[0][0], corners_orig[1][0],
                           corners_orig[2][0], corners_orig[3][0], u_interp,
                           v_interp);
        } else {
          cy = (dy / 15.0) * (block->blockmaxy - block->blockminy) +
               block->blockminy;
        }

        if (block->interpolateu) {
          cu = interpolate(corners_orig[0][1], corners_orig[1][1],
                           corners_orig[2][1], corners_orig[3][1], u_interp,
                           v_interp);
        } else {
          cu = (du / 3.0) * (block->blockmaxu - block->blockminu) +
               block->blockminu;
        }

        if (block->interpolatev) {
          cv = interpolate(corners_orig[0][2], corners_orig[1][2],
                           corners_orig[2][2], corners_orig[3][2], u_interp,
                           v_interp);
        } else {
          cv = (dv / 3.0) * (block->blockmaxv - block->blockminv) +
               block->blockminv;
        }

        RGB_Pixel rgb = yuv_to_rgb_norm(cy, cu, cv);

        uint8_t *pixels = (uint8_t *)pixel_data_ptr;
        size_t linear_byte_offset =
            ((current_y + blockY) * width + (current_x + blockX)) * 3;
        pixels[linear_byte_offset] = (uint8_t)fmax(0, fmin(255, round(rgb.r)));
        pixels[linear_byte_offset + 1] =
            (uint8_t)fmax(0, fmin(255, round(rgb.g)));
        pixels[linear_byte_offset + 2] =
            (uint8_t)fmax(0, fmin(255, round(rgb.b)));
      }
    }
  }

  VipsImage *out_image;
  out_image = vips_image_new_from_memory(pixel_data_ptr, pixel_data_size, width,
                                         height, 3, VIPS_FORMAT_UCHAR);
  if (!out_image) {
    vips_error_exit(NULL);
  }
  if (strcmp(output_file, "-") == 0) {

    void *output_buffer;
    size_t output_size;
    if (vips_image_write_to_buffer(out_image, ".png", &output_buffer,
                                   &output_size, NULL) != 0) {
      vips_error_exit(NULL);
    }
    fwrite(output_buffer, 1, output_size, stdout);
    g_free(output_buffer);
  } else {
    if (vips_image_write_to_file(out_image, output_file, NULL) != 0) {
      vips_error_exit(NULL);
    }
  }

  g_free(pixel_data_ptr);
  g_object_unref(out_image);
  free_imgdata(imgdata);
  vips_shutdown();

#ifdef _WIN32
  WSACleanup();
#endif
  fprintf(stderr, "Done.\n");
  return 0;
}

RGB_Pixel yuv_to_rgb_norm(double Y, double U, double V) {
  RGB_Pixel rgb;
  rgb.r = Y + 1.402 * (V - 128);
  rgb.g = Y - 0.344 * (U - 128) - 0.714 * (V - 128);
  rgb.b = Y + 1.772 * (U - 128);
  return rgb;
}

int pix_delta_rev(int prev, int delta, int max) { return (prev + delta) % max; }

double interpolate(double tl, double tr, double bl, double br, double u,
                   double v) {
  double top = tl * (1 - u) + tr * u;
  double bottom = bl * (1 - u) + br * u;
  return top * (1 - v) + bottom * v;
}