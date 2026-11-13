-- The lib cache: reuse parsed source files across checks in this Lua state.
-- `require("sourcecache").enable()` turns it on; lua/tsc.lua never loads this
-- module, so the oracle measures plain checks.
--
-- tsgo's watch mode (execute.watchCompilerHost) and language service
-- (project.ParseCache) do the same: a program asks its compiler host for each
-- file, and the host hands back the ast.SourceFile it parsed for an earlier
-- program when the file is unchanged. A SourceFile is bound once
-- (SourceFile:BindOnce), so its binding is reused too; checkers keep their own
-- state. The key is what project.NewParseCacheKey uses (file name, path, the
-- external module indicator options), with the text itself standing in for
-- the content hash.
local M = {}
local sourceFiles

function M.enable()
    if sourceFiles ~= nil then return end
    sourceFiles = {}
    local compiler = require("tslua.compiler")
    local core = require("tslua.core")
    local parser = require("tslua.parser")
    function compiler.compilerHost:GetSourceFile(opts)
        local text, ok = self:FS():ReadFile(opts.fileName)
        if not ok then
            return nil
        end
        local emi = opts.externalModuleIndicatorOptions
        local key = opts.fileName .. "\0" .. opts.path .. "\0" ..
            ((emi ~= nil and emi.jsx) and "1" or "0") .. ((emi ~= nil and emi.force) and "1" or "0")
        local hit = sourceFiles[key]
        if hit ~= nil and hit.text == text then
            return hit.file
        end
        local file = parser.ParseSourceFile(opts, text, core.EnsureScriptKindFromFileName(opts.fileName))
        sourceFiles[key] = { text = text, file = file }
        return file
    end
end

return M
