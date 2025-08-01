ENCODER_TARGET = enc_img
DECODER_TARGET = dec_img

BINFMT_SRC = binfmt.c

ENCODER_SRC = compress.c $(BINFMT_SRC)
DECODER_SRC = decompress.c $(BINFMT_SRC)

VIPS_CFLAGS = $(shell pkg-config --cflags vips)
VIPS_LIBS = $(shell pkg-config --libs vips)

CC = gcc
CFLAGS = -Wall -Wextra -O3 $(VIPS_CFLAGS)
LDFLAGS = $(VIPS_LIBS)

ENCODER_OBJS = $(ENCODER_SRC:.c=.o)
DECODER_OBJS = $(DECODER_SRC:.c=.o)

all: $(ENCODER_TARGET) $(DECODER_TARGET)

$(ENCODER_TARGET): $(ENCODER_OBJS)
	$(CC) -o $@ $^ $(LDFLAGS) -lm

$(DECODER_TARGET): $(DECODER_OBJS)
	$(CC) -o $@ $^ $(LDFLAGS) -lm

%.o: %.c
	$(CC) $(CFLAGS) -c $< -o $@

clean:
	rm -f $(ENCODER_TARGET) $(DECODER_TARGET) $(ENCODER_OBJS) $(DECODER_OBJS)

.PHONY: all clean