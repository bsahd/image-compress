#!/usr/bin/env lua
local ffi = require "ffi"
local vips = require "vips"
local binfmt = require "lua-ver.binfmt"

local args = { ... }
local input_file = args[1] or error("Input file required")
local output_file = args[2] or error("Output file required")

local function yuv_to_rgb_norm(Y, U, V)
  local R = Y + 1.402 * (V - 128)
  local G = Y - 0.344 * (U - 128) - 0.714 * (V - 128)
  local B = Y + 1.772 * (U - 128)
  return R, G, B
end

local function pix_delta_rev(prev, delta, max)
  return (prev + delta) % max
end

local data
if input_file == "-" then
  data = io.stdin:read("*a")
else
  local in_file = io.open(input_file, "rb")
  if not in_file then error("Could not open input file: " .. input_file) end
  data = in_file:read("*a")
  in_file:close()
end

local imgdata = binfmt.buf_to_img(data)
local width, height = imgdata.width, imgdata.height

local pixel_data_ptr = ffi.new("unsigned char[?]", width * height * 3)

print("Decoding...")
local current_x = -8
local current_y = 0

for _, block in ipairs(imgdata.blocks) do
  current_x = current_x + 8
  if current_x >= width then
    current_y = current_y + 8
    current_x = 0
  end

  local corners_orig = {}
  for _, corner in ipairs(block.corners) do
    local oy = (math.floor(corner / 16) / 15) * (block.blockmaxy - block.blockminy) + block.blockminy
    local ou = (math.floor((corner % 16) / 4) / 3) * (block.blockmaxu - block.blockminu) + block.blockminu
    local ov = (math.floor(corner % 4) / 3) * (block.blockmaxv - block.blockminv) + block.blockminv
    table.insert(corners_orig, { oy, ou, ov })
  end

  local function interpolate(tl, tr, bl, br, u, v)
    local top = tl * (1 - u) + tr * u
    local bottom = bl * (1 - u) + br * u
    return top * (1 - v) + bottom * v
  end

  local prevpix = { 0, 0, 0 }
  for blockY = 0, 7 do
    for blockX = 0, 7 do
      local nblock_val                       = block.nblock4bn[blockY + 1][blockX + 1]
      local oy_val                           = math.floor(nblock_val / 16)
      local ou_val                           = math.floor((nblock_val % 16) / 4)
      local ov_val                           = math.floor(nblock_val % 4)

      local dy                               = pix_delta_rev(prevpix[1], oy_val, 16)
      local du                               = pix_delta_rev(prevpix[2], ou_val, 4)
      local dv                               = pix_delta_rev(prevpix[3], ov_val, 4)
      prevpix                                = { dy, du, dv }

      local u_interp, v_interp               = blockX / 7, blockY / 7

      local cy                               = block.interpolatey and
          interpolate(corners_orig[1][1], corners_orig[2][1], corners_orig[3][1], corners_orig[4][1], u_interp, v_interp) or
          (dy / 15) * (block.blockmaxy - block.blockminy) + block.blockminy

      local cu                               = block.interpolateu and
          interpolate(corners_orig[1][2], corners_orig[2][2], corners_orig[3][2], corners_orig[4][2], u_interp, v_interp) or
          (du / 3) * (block.blockmaxu - block.blockminu) + block.blockminu

      local cv                               = block.interpolatev and
          interpolate(corners_orig[1][3], corners_orig[2][3], corners_orig[3][3], corners_orig[4][3], u_interp, v_interp) or
          (dv / 3) * (block.blockmaxv - block.blockminv) + block.blockminv

      local r, g, b                          = yuv_to_rgb_norm(cy, cu, cv)

      local clamped_r                        = math.max(0, math.min(255, math.floor(r + 0.5)))
      local clamped_g                        = math.max(0, math.min(255, math.floor(g + 0.5)))
      local clamped_b                        = math.max(0, math.min(255, math.floor(b + 0.5)))

      local linear_byte_offset               = ((current_y + blockY) * width + (current_x + blockX)) * 3
      pixel_data_ptr[linear_byte_offset]     = clamped_r
      pixel_data_ptr[linear_byte_offset + 1] = clamped_g
      pixel_data_ptr[linear_byte_offset + 2] = clamped_b
    end
  end
end

local out_image = vips.Image.new_from_memory(pixel_data_ptr, width, height, 3, "uchar")

if output_file == "-" then
  local output_buffer = out_image:write_to_buffer(".png")
  io.stdout:write(output_buffer)
else
  out_image:write_to_file(output_file)
end

io.stderr:write("Done.\n")
