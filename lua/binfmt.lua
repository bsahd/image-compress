local msg =
"this is binary image of https://github.com/bsahd/image-compress format.\nversion:230606ee9a6d0b45b71167f8faa01ed169cd96bb\n\n\n\n\n\n\n\n\n"
local endmsg = "\n\n\nthis is binary format. read head using head command for more information.\n"
local struct
if string.pack then
    struct = { pack = string.pack, unpack = string.unpack }
else
    struct = require("struct")
end

local _unpack
if table.unpack then
    _unpack = table.unpack
else
    _unpack = unpack
end

local M = {}
function M.buf_to_img(data)
    local img = {}
    local read_head = 1

    local function read_buf(fmt)
        local results_from_unpack = { struct.unpack(fmt, data, read_head) }
        local next_pos = nil
        local actual_values = {}
        if #results_from_unpack == 0 then
            error("Failed to unpack data for format: " .. fmt .. " at position: " .. read_head .. ". No values returned.")
        end
        next_pos = results_from_unpack[#results_from_unpack]
        for i = 1, #results_from_unpack - 1 do
            actual_values[i] = results_from_unpack[i]
        end
        read_head = next_pos
        return _unpack(actual_values)
    end

    local header = read_buf("c" .. #msg)
    assert(header == msg, "Invalid header")

    img.width = read_buf(">i2")
    img.height = read_buf(">i2")
    local blockcount = read_buf(">i4")
    img.blocks = {}

    for i = 1, blockcount do
        local elem = {}
        elem.blockmaxy, elem.blockminy, elem.blockmaxu, elem.blockminu, elem.blockmaxv, elem.blockminv = read_buf(
            ">BBBBBB")
        local interpolaten = read_buf(">B")
        elem.interpolatey = interpolaten >= 4
        elem.interpolateu = (interpolaten % 4) >= 2
        elem.interpolatev = (interpolaten % 2) == 1
        elem.corners = {}
        elem.nblock4bn = {}
        table.insert(img.blocks, elem)
    end

    for i = 1, blockcount do
        if not img.blocks[i] then error("Block " .. i .. " not found in img.blocks") end
        for _ = 1, 4 do
            table.insert(img.blocks[i].corners, read_buf(">B"))
        end
    end

    for i = 1, blockcount do
        if not img.blocks[i] then error("Block " .. i .. " not found in img.blocks for nblock4bn") end
        for _ = 1, 8 do
            local row = {}
            for _ = 1, 8 do
                table.insert(row, read_buf(">B"))
            end
            table.insert(img.blocks[i].nblock4bn, row)
        end
    end

    local footer = read_buf("c" .. #endmsg)
    assert(footer == endmsg, "Invalid footer")

    return img
end

function M.img_to_buf(img)
    local parts = {}
    table.insert(parts, msg)
    table.insert(parts, struct.pack(">i2", img.width))
    table.insert(parts, struct.pack(">i2", img.height))
    table.insert(parts, struct.pack(">i4", #img.blocks))

    for _, block in ipairs(img.blocks) do
        table.insert(parts,
            struct.pack(">BBBBBB", block.blockmaxy, block.blockminy, block.blockmaxu, block.blockminu, block.blockmaxv,
                block.blockminv))
        local interpolaten = (block.interpolatey and 4 or 0) + (block.interpolateu and 2 or 0) +
            (block.interpolatev and 1 or 0)
        table.insert(parts, struct.pack(">B", interpolaten))
    end

    for _, block in ipairs(img.blocks) do
        for _, corner in ipairs(block.corners) do
            table.insert(parts, struct.pack(">B", corner))
        end
    end

    for _, block in ipairs(img.blocks) do
        for _, row in ipairs(block.nblock4bn) do
            for _, p in ipairs(row) do
                table.insert(parts, struct.pack(">B", p))
            end
        end
    end

    table.insert(parts, endmsg)
    return table.concat(parts)
end

return M
