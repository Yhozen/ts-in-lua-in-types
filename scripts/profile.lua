-- The dynamic profile's instrumentation (scripts/profile.ts). Runs before
-- `require "tsc"` so that tslua's `local f = string.f` aliases capture the
-- wrappers; counting only happens between __BEFORE() and __AFTER(), i.e.
-- during tsc.check. Wrappers tail-call the original, so they add no frame
-- that error levels or debug.getinfo levels could see (except pcall/xpcall,
-- which must restore the depth counter after an unwind).

local P = {
    on = false,
    calls = {}, -- "string.byte" -> n
    strArgs = {}, -- "string.byte" -> { n, total, max } over the first argument's length
    patterns = {}, -- "find\0pattern" -> n
    formats = {}, -- format string -> n
    packFormats = {}, -- "pack\0fmt" -> n
    gsubRepl = {}, -- replacement kind -> n
    plainFind = 0,
    metamethods = {}, -- "index Lua" -> n
    metatableFields = {}, -- "__index table" -> n (per setmetatable call while on)
    pcallFailed = 0,
    depth = 0,
    luaDepth = 0,
    maxDepth = 0,
    maxLuaDepth = 0,
    floatsFormatted = 0,
    floatsFromTonumber = 0,
    lazyRequires = {},
    touched = {}, -- "os.time" -> first call site
}
__PROFILE = P

local getinfo, sethook = debug.getinfo, debug.sethook
local type, select, mathtype, pairs_, tostring_ = type, select, math.type, pairs, tostring
local ssub, sfind, ipairs_ = string.sub, string.find, ipairs

local EVENTS = {
    "__index", "__newindex", "__call", "__eq", "__lt", "__le", "__len", "__tostring", "__concat",
    "__close", "__mode", "__pairs", "__gc", "__name", "__metatable", "__add", "__sub", "__mul",
    "__div", "__mod", "__pow", "__unm", "__idiv", "__band", "__bor", "__bxor", "__shl", "__shr",
    "__bnot",
}
local handlerEvent = {} -- function -> event name, from metatables seen by setmetatable

local function bump(t, k, n)
    t[k] = (t[k] or 0) + (n or 1)
end

local function site(level)
    local info = getinfo(level, "Sl")
    return info and (info.short_src .. ":" .. tostring_(info.currentline)) or "?"
end

local function count(key)
    if P.on then bump(P.calls, key) end
end

local function strArg(key, s)
    if P.on and type(s) == "string" then
        local a = P.strArgs[key]
        if not a then
            a = { 0, 0, 0 }
            P.strArgs[key] = a
        end
        local n = #s
        a[1] = a[1] + 1
        a[2] = a[2] + n
        if n > a[3] then a[3] = n end
    end
end

local function hasFloat(...)
    for i = 1, select("#", ...) do
        if mathtype((select(i, ...))) == "float" then return true end
    end
    return false
end

local function replKind(r)
    local t = type(r)
    if t == "table" then return "table" end
    if t == "function" then return "function" end
    if t == "string" then return sfind(r, "%", 1, true) and "string with %" or "string" end
    return t
end

-- string library (also reached by s:method(...) through the string metatable).
local S = string
for _, name in ipairs({ "byte", "char", "dump", "find", "format", "gmatch", "gsub", "len", "lower", "match",
    "pack", "packsize", "rep", "reverse", "sub", "unpack", "upper" }) do
    local orig = S[name]
    local key = "string." .. name
    local f
    if name == "find" then
        f = function(s, p, init, plain, ...)
            if P.on then
                count(key)
                strArg(key, s)
                if plain then P.plainFind = P.plainFind + 1 else bump(P.patterns, "find\0" .. tostring_(p)) end
            end
            return orig(s, p, init, plain, ...)
        end
    elseif name == "match" or name == "gmatch" then
        f = function(s, p, ...)
            if P.on then
                count(key)
                strArg(key, s)
                bump(P.patterns, name .. "\0" .. tostring_(p))
            end
            return orig(s, p, ...)
        end
    elseif name == "gsub" then
        f = function(s, p, r, ...)
            if P.on then
                count(key)
                strArg(key, s)
                bump(P.patterns, "gsub\0" .. tostring_(p))
                bump(P.gsubRepl, replKind(r))
            end
            return orig(s, p, r, ...)
        end
    elseif name == "format" then
        f = function(fmt, ...)
            if P.on then
                count(key)
                bump(P.formats, tostring_(fmt))
                if hasFloat(...) then P.floatsFormatted = P.floatsFormatted + 1 end
            end
            return orig(fmt, ...)
        end
    elseif name == "pack" or name == "unpack" or name == "packsize" then
        f = function(fmt, ...)
            if P.on then
                count(key)
                bump(P.packFormats, name .. "\0" .. tostring_(fmt))
            end
            return orig(fmt, ...)
        end
    elseif name == "char" then
        f = function(...)
            if P.on then
                count(key)
                local a = P.strArgs[key] or { 0, 0, 0 }
                P.strArgs[key] = a
                local n = select("#", ...)
                a[1], a[2] = a[1] + 1, a[2] + n
                if n > a[3] then a[3] = n end
            end
            return orig(...)
        end
    else
        f = function(s, ...)
            if P.on then
                count(key)
                strArg(key, s)
            end
            return orig(s, ...)
        end
    end
    S[name] = f
end

-- Other libraries: count calls; os/io/debug/coroutine/package also record where.
local watched = { os = true, io = true, debug = true, coroutine = true }
for _, lib in ipairs({ "table", "math", "utf8", "os", "io", "debug", "coroutine" }) do
    local t = _G[lib]
    local names = {}
    for k, v in pairs_(t) do
        if type(v) == "function" then names[#names + 1] = k end
    end
    table.sort(names)
    for _, name in ipairs(names) do
        local orig = t[name]
        local key = lib .. "." .. name
        if watched[lib] then
            t[name] = function(...)
                if P.on then
                    bump(P.calls, key)
                    if not P.touched[key] then P.touched[key] = site(3) end
                end
                return orig(...)
            end
        else
            t[name] = function(...)
                if P.on then bump(P.calls, key) end
                return orig(...)
            end
        end
    end
end

-- Base functions.
local base = {}
for _, name in ipairs({ "assert", "error", "getmetatable", "ipairs", "next", "pairs", "rawequal", "rawget",
    "rawlen", "rawset", "select", "tonumber", "tostring", "type" }) do
    local orig = _G[name]
    base[name] = orig
    if name == "tostring" then
        _G[name] = function(v, ...)
            if P.on then
                bump(P.calls, name)
                if mathtype(v) == "float" then P.floatsFormatted = P.floatsFormatted + 1 end
            end
            return orig(v, ...)
        end
    elseif name == "tonumber" then
        _G[name] = function(...)
            local r = orig(...)
            if P.on then
                bump(P.calls, name)
                if mathtype(r) == "float" then P.floatsFromTonumber = P.floatsFromTonumber + 1 end
            end
            return r
        end
    else
        _G[name] = function(...)
            if P.on then bump(P.calls, name) end
            return orig(...)
        end
    end
end
for _, name in ipairs({ "load", "loadfile", "dofile", "collectgarbage", "print", "warn" }) do
    local orig = _G[name]
    if orig then
        _G[name] = function(...)
            if P.on then
                bump(P.calls, name)
                if not P.touched[name] then P.touched[name] = site(3) end
            end
            return orig(...)
        end
    end
end

local origRequire = require
require = function(name, ...)
    if P.on then
        bump(P.calls, "require")
        if not package.loaded[name] then bump(P.lazyRequires, name) end
    end
    return origRequire(name, ...)
end

local origSetmetatable = setmetatable
setmetatable = function(t, mt)
    if mt ~= nil and type(mt) == "table" then
        for _, ev in ipairs_(EVENTS) do
            local h = base.rawget(mt, ev)
            if h ~= nil then
                if type(h) == "function" and handlerEvent[h] == nil then handlerEvent[h] = ev end
                if P.on then bump(P.metatableFields, ev .. " " .. type(h)) end
            end
        end
    end
    if P.on then bump(P.calls, "setmetatable") end
    return origSetmetatable(t, mt)
end

-- pcall/xpcall: count, count failures, restore the depth counters after an unwind.
local origPcall, origXpcall = pcall, xpcall
local function settle(d, ld, ok, ...)
    P.depth, P.luaDepth = d, ld
    if P.on and not ok then P.pcallFailed = P.pcallFailed + 1 end
    return ok, ...
end
pcall = function(...)
    if P.on then bump(P.calls, "pcall") end
    local d, ld = P.depth, P.luaDepth
    return settle(d, ld, origPcall(...))
end
xpcall = function(...)
    if P.on then bump(P.calls, "xpcall") end
    local d, ld = P.depth, P.luaDepth
    return settle(d, ld, origXpcall(...))
end

-- The call hook: depth, and metamethod invocations.
local luaFrame = {} -- stack of booleans: is frame i a Lua function?
local function hook(event)
    if event == "call" then
        local info = getinfo(2, "nSf")
        local d = P.depth + 1
        P.depth = d
        local isLua = info.what ~= "C"
        luaFrame[d] = isLua
        if isLua then
            local ld = P.luaDepth + 1
            P.luaDepth = ld
            if ld > P.maxLuaDepth then P.maxLuaDepth = ld end
        end
        if d > P.maxDepth then P.maxDepth = d end
        if info.namewhat == "metamethod" then
            bump(P.metamethods, tostring_(info.name) .. " " .. info.what)
        else
            local ev = handlerEvent[info.func]
            if ev == "__call" then
                bump(P.metamethods, "call " .. info.what .. " (by identity)")
            elseif ev ~= nil and ev ~= "__index" and ev ~= "__newindex" and ev ~= "__eq" and ev ~= "__lt"
                and ev ~= "__le" and ev ~= "__concat" and ev ~= "__len" then
                -- Called from C (tostring -> __tostring, pairs -> __pairs, close -> __close)?
                local caller = getinfo(3, "S")
                if caller and caller.what == "C" then
                    bump(P.metamethods, ssub(ev, 3) .. " " .. info.what .. " (from C)")
                end
            end
        end
    elseif event == "tail call" then
        local info = getinfo(2, "nS")
        local d = P.depth
        local isLua = info.what ~= "C"
        if luaFrame[d] ~= isLua then
            P.luaDepth = P.luaDepth + (isLua and 1 or -1)
            luaFrame[d] = isLua
        end
        if info.namewhat == "metamethod" then bump(P.metamethods, tostring_(info.name) .. " " .. info.what) end
    else -- return
        local d = P.depth
        if luaFrame[d] then P.luaDepth = P.luaDepth - 1 end
        P.depth = d - 1
    end
end

function __BEFORE()
    P.on = true
    -- The hook sees sethook (C) and then __BEFORE (Lua) return: start at 2 so
    -- that the harness chunk is depth 0.
    P.depth, P.luaDepth = 2, 1
    luaFrame[1], luaFrame[2] = true, false
    sethook(hook, "cr")
end

function __AFTER()
    sethook()
    P.on = false
end

-- A small JSON encoder with sorted keys, for the epilogue.
local function encode(v, out)
    local t = type(v)
    if t == "table" then
        if #v > 0 or next(v) == nil then
            local first = true
            if next(v) == nil then
                out[#out + 1] = "{}"
                return
            end
            out[#out + 1] = "["
            for _, x in ipairs(v) do
                if not first then out[#out + 1] = "," end
                first = false
                encode(x, out)
            end
            out[#out + 1] = "]"
        else
            local keys = {}
            for k in pairs_(v) do keys[#keys + 1] = tostring_(k) end
            table.sort(keys)
            out[#out + 1] = "{"
            for i, k in ipairs(keys) do
                if i > 1 then out[#out + 1] = "," end
                encode(k, out)
                out[#out + 1] = ":"
                encode(v[k], out)
            end
            out[#out + 1] = "}"
        end
    elseif t == "string" then
        out[#out + 1] = '"' .. v:gsub('[%c"\\\128-\255]', function(c)
            return string.format("\\u%04x", c:byte())
        end) .. '"'
    elseif t == "number" or t == "boolean" then
        out[#out + 1] = tostring_(v)
    else
        out[#out + 1] = "null"
    end
end

function __PROFILE_JSON()
    P.on = false
    local out = {}
    local copy = {}
    for k, v in pairs_(P) do
        if k ~= "on" then copy[k] = v end
    end
    encode(copy, out)
    return table.concat(out)
end
