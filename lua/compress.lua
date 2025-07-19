#!/usr/bin/env lua

local vips = require "vips"
local binfmt = require "lua.binfmt"

local _unpack
if table.unpack then
    _unpack = table.unpack
else
    _unpack = unpack
end

local args = { ... }
local COMPRESS_LEVEL = tonumber(args[1]) or 16
local input_file = args[2] or error("Input file required")
local output_file = args[3] or error("Output file required")

local function rgb_to_yuv_norm(r, g, b)
    local Y = 0.299 * r + 0.587 * g + 0.114 * b
    local U = -0.169 * r - 0.331 * g + 0.5 * b + 128
    local V = 0.5 * r - 0.419 * g - 0.081 * b + 128
    return Y, U, V
end

local function pix_delta(prev, now, max)
    if now >= prev then
        return now - prev
    else
        return max + now - prev
    end
end

local image
if input_file == "-" then
    local input_buffer = io.stdin:read("*a")
    if not input_buffer or #input_buffer == 0 then
        error("No data received from standard input.")
    end
    image = vips.Image.new_from_buffer(input_buffer, {})
else
    image = vips.Image.new_from_file(input_file)
end

local width, height = image:width(), image:height()
local bands = image:get("bands")

if bands == 4 then
    io.stderr:write("Alpha channel detected, extracting RGB bands.\n")
    image = image:extract_band(0, { n = 3 })
    bands = 3
end

local pad_right = (8 - (width % 8)) % 8
local pad_bottom = (8 - (height % 8)) % 8

if pad_right > 0 or pad_bottom > 0 then
    image = image:embed(0, 0, width + pad_right, height + pad_bottom, { extend = 'black' })
    width, height = image:width(), image:height()
    io.stderr:write("Extended to " .. width .. "x" .. height .. "\n")
end

local pixels = image:write_to_buffer(".raw")

if not pixels then
    error("Failed to convert image to raw pixel buffer.")
end

local imgdata = { width = width, height = height, blocks = {} }

io.stderr:write("Encoding...\n")
for y = 0, height - 1, 8 do
    for x = 0, width - 1, 8 do
        local block_yuv = {}

        for by = 0, 7 do
            block_yuv[by + 1] = {}
            for bx = 0, 7 do
                local offset = ((y + by) * width + (x + bx)) * 3 + 1

                local r = string.byte(pixels, offset)
                local g = string.byte(pixels, offset + 1)
                local b = string.byte(pixels, offset + 2)
                local Y, U, V = rgb_to_yuv_norm(r, g, b)

                block_yuv[by + 1][bx + 1] = { Y, U, V }
            end
        end

        local function get_channel_stats(block, channel)
            local min_val, max_val = 256, -1
            for _, row in ipairs(block) do
                for _, px in ipairs(row) do
                    local val = px[channel]
                    min_val = math.min(min_val, val)
                    max_val = math.max(max_val, val)
                end
            end
            max_val = math.ceil(max_val)
            if max_val == 256 then max_val = 255 end
            local min_val_f = math.floor(min_val)
            return min_val_f, max_val, max_val - min_val_f
        end

        local blockminy, blockmaxy, drangey = get_channel_stats(block_yuv, 1)
        local blockminu, blockmaxu, drangeu = get_channel_stats(block_yuv, 2)
        local blockminv, blockmaxv, drangev = get_channel_stats(block_yuv, 3)

        local nblock = {}
        for yi, row in ipairs(block_yuv) do
            nblock[yi] = {}
            for xi, px in ipairs(row) do
                local cy, cu, cv = _unpack(px)
                nblock[yi][xi] = {
                    drangey < COMPRESS_LEVEL / 2 and 0 or (cy - blockminy) / drangey,
                    drangeu < COMPRESS_LEVEL and 0 or (cu - blockminu) / drangeu,
                    drangev < COMPRESS_LEVEL and 0 or (cv - blockminv) / drangev,
                }
            end
        end

        local prevpix = { 0, 0, 0 }
        local nblock4b = {}
        for yi, row in ipairs(nblock) do
            nblock4b[yi] = {}
            for xi, px in ipairs(row) do
                local cy, cu, cv = _unpack(px)
                local qy = math.floor(cy * 15.9)
                local qu = math.floor(cu * 3.9)
                local qv = math.floor(cv * 3.9)
                nblock4b[yi][xi] = {
                    pix_delta(prevpix[1], qy, 16),
                    pix_delta(prevpix[2], qu, 4),
                    pix_delta(prevpix[3], qv, 4),
                }
                prevpix = { qy, qu, qv }
            end
        end

        local nblock4bn = {}
        for yi, row in ipairs(nblock4b) do
            nblock4bn[yi] = {}
            for xi, p in ipairs(row) do
                local r_delta, g_delta, b_delta = _unpack(p)
                nblock4bn[yi][xi] = (r_delta * 4 + g_delta) * 4 + b_delta
            end
        end

        local corners_raw = { block_yuv[1][1], block_yuv[1][8], block_yuv[8][1], block_yuv[8][8] }
        local corners = {}
        for _, p_table in ipairs(corners_raw) do
            local cy, cu, cv = _unpack(p_table)
            local norm_y = drangey > 0 and (cy - blockminy) / drangey or 0
            local norm_u = drangeu > 0 and (cu - blockminu) / drangeu or 0
            local norm_v = drangev > 0 and (cv - blockminv) / drangev or 0
            local qy = drangey < COMPRESS_LEVEL / 2 and math.floor(norm_y * 15.9) or 0
            local qu = drangeu < COMPRESS_LEVEL and math.floor(norm_u * 3.9) or 0
            local qv = drangev < COMPRESS_LEVEL and math.floor(norm_v * 3.9) or 0
            table.insert(corners, (qy * 4 + qu) * 4 + qv)
        end

        table.insert(imgdata.blocks, {
            blockmaxy = blockmaxy,
            blockminy = blockminy,
            blockmaxu = blockmaxu,
            blockminu = blockminu,
            blockmaxv = blockmaxv,
            blockminv = blockminv,
            nblock4bn = nblock4bn,
            interpolatey = drangey < COMPRESS_LEVEL / 2,
            interpolateu = drangeu < COMPRESS_LEVEL,
            interpolatev = drangev < COMPRESS_LEVEL,
            corners = corners,
        })
    end
end

local compressed_data = binfmt.img_to_buf(imgdata)

if output_file == "-" then
    io.stdout:write(compressed_data)
else
    local out_file = io.open(output_file, "wb")
    if not out_file then error("Could not open output file: " .. output_file) end
    out_file:write(compressed_data)
    out_file:close()
end

io.stderr:write("Done.\n")
