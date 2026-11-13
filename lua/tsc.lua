-- The oracle harness: run tslua's `tsc` command line on an in-memory project
-- and return everything it prints.
--
-- This file also runs on the lua-in-types v2 reference interpreter and, later,
-- inside the types, so it stays deterministic: no io, os, debug, load or
-- coroutines, and nothing that depends on `pairs` order (vfstest sorts the
-- file map by path before building the file system).

local execute = require("tslua.execute")
local vfstest = require("tslua.vfs.vfstest")

local M = {}

-- A clock that never moves: file times and timings come out as 0.
local clock = {}
clock.__index = clock
function clock:Now() return 0 end
function clock:SinceStart() return 0 end

-- io.Writer collecting into a list (diagnosticwriter calls WriteString, json calls Write).
local writer = {}
writer.__index = writer
function writer:WriteString(s)
    local parts = self.parts
    parts[#parts + 1] = s
    return #s, nil
end
writer.Write = writer.WriteString

-- The system shim execute.CommandLine runs against.
local sys = {}
sys.__index = sys
function sys:SinceStart() return 0 end
function sys:Now() return 0 end
function sys:FS() return self.fs end
function sys:DefaultLibraryPath() return self.defaultLibraryPath end
function sys:GetCurrentDirectory() return self.cwd end
function sys:Writer() return self.writer end
function sys:ErrorWriter() return self.writer end
function sys:WriteOutputIsTTY() return false end
function sys:GetWidthOfTerminal() return 0 end
function sys:GetEnvironmentVariable() return "" end

M.cwd = "/p"
M.defaultLibraryPath = "/lib"

-- check(files, args) -> output, exit status
--   files: absolute path -> contents
--   args:  the command line, a list of strings (paths relative to M.cwd)
function M.check(files, args)
    local w = setmetatable({ parts = {} }, writer)
    local s = setmetatable({
        cwd = M.cwd,
        fs = vfstest.FromMapWithClock(files, true, setmetatable({}, clock)),
        defaultLibraryPath = M.defaultLibraryPath,
        writer = w,
    }, sys)
    local result = execute.CommandLine(nil, s, args, nil)
    return table.concat(w.parts), result.status
end

return M
