<#
.SYNOPSIS
    Dumps a COM type library to text: every interface, method, parameter and type.

.DESCRIPTION
    Written for `Bin64\vdfdbg.dll`, the DataFlex debugger engine, whose automation API is registered
    and type-library-described but undocumented. A string scan of the DLL is enough to tell that the
    API exists; it is not enough to call it. This reads the real thing through `ITypeLib`.

    `LoadTypeLibEx` is called with REGKIND_NONE, so nothing is registered as a side effect and the
    file is only read.

.EXAMPLE
    pwsh -File scripts/dump-typelib.ps1 -Path "C:\Program Files\DataFlex 26.0\Bin64\vdfdbg.dll"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $Path,

    # Where to write the dump. Prints to stdout when omitted.
    [string] $OutFile
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

public static class TypeLibDumper
{
    [DllImport("oleaut32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void LoadTypeLibEx(string file, int regKind, out ITypeLib typeLib);

    private const int REGKIND_NONE = 2;

    public static string Dump(string path)
    {
        ITypeLib lib;
        LoadTypeLibEx(path, REGKIND_NONE, out lib);

        var sb = new StringBuilder();
        string libName, libDoc, libHelp;
        int libCtx;
        lib.GetDocumentation(-1, out libName, out libDoc, out libCtx, out libHelp);
        sb.AppendLine("library " + libName + "  -- " + libDoc);
        sb.AppendLine("source: " + path);
        sb.AppendLine();

        int count = lib.GetTypeInfoCount();
        for (int i = 0; i < count; i++)
        {
            ITypeInfo info;
            lib.GetTypeInfo(i, out info);
            DumpTypeInfo(info, sb);
        }
        return sb.ToString();
    }

    private static void DumpTypeInfo(ITypeInfo info, StringBuilder sb)
    {
        IntPtr pAttr;
        info.GetTypeAttr(out pAttr);
        try
        {
            var attr = (TYPEATTR)Marshal.PtrToStructure(pAttr, typeof(TYPEATTR));

            string name, doc, help;
            int ctx;
            info.GetDocumentation(-1, out name, out doc, out ctx, out help);

            sb.AppendLine("========================================================================");
            sb.AppendLine(Kind(attr.typekind) + " " + name + "   {" + attr.guid.ToString().ToUpperInvariant() + "}");
            if (!string.IsNullOrEmpty(doc)) sb.AppendLine("  // " + doc);
            sb.AppendLine("  funcs: " + attr.cFuncs + "   vars: " + attr.cVars + "   implTypes: " + attr.cImplTypes);

            for (int i = 0; i < attr.cImplTypes; i++)
            {
                int href;
                info.GetRefTypeOfImplType(i, out href);
                ITypeInfo impl;
                info.GetRefTypeInfo(href, out impl);
                string iname, idoc, ihelp;
                int ictx;
                impl.GetDocumentation(-1, out iname, out idoc, out ictx, out ihelp);
                sb.AppendLine("  implements " + iname);
            }

            for (int i = 0; i < attr.cFuncs; i++)
            {
                DumpFunc(info, i, sb);
            }

            for (int i = 0; i < attr.cVars; i++)
            {
                IntPtr pVar;
                info.GetVarDesc(i, out pVar);
                try
                {
                    var v = (VARDESC)Marshal.PtrToStructure(pVar, typeof(VARDESC));
                    string vn, vd, vh;
                    int vc;
                    info.GetDocumentation(v.memid, out vn, out vd, out vc, out vh);
                    sb.AppendLine("  const " + vn + (string.IsNullOrEmpty(vd) ? "" : "   // " + vd));
                }
                finally { info.ReleaseVarDesc(pVar); }
            }
            sb.AppendLine();
        }
        finally { info.ReleaseTypeAttr(pAttr); }
    }

    private static void DumpFunc(ITypeInfo info, int index, StringBuilder sb)
    {
        IntPtr pFunc;
        info.GetFuncDesc(index, out pFunc);
        try
        {
            var f = (FUNCDESC)Marshal.PtrToStructure(pFunc, typeof(FUNCDESC));

            string name, doc, help;
            int ctx;
            info.GetDocumentation(f.memid, out name, out doc, out ctx, out help);

            // GetNames returns the method name followed by one name per parameter.
            var names = new string[f.cParams + 1];
            int got;
            info.GetNames(f.memid, names, names.Length, out got);

            string prefix = "";
            if (f.invkind == INVOKEKIND.INVOKE_PROPERTYGET) prefix = "get ";
            else if (f.invkind == INVOKEKIND.INVOKE_PROPERTYPUT) prefix = "put ";
            else if (f.invkind == INVOKEKIND.INVOKE_PROPERTYPUTREF) prefix = "putref ";

            var ps = new List<string>();
            for (int i = 0; i < f.cParams; i++)
            {
                IntPtr pElem = new IntPtr(f.lprgelemdescParam.ToInt64() + i * Marshal.SizeOf(typeof(ELEMDESC)));
                var elem = (ELEMDESC)Marshal.PtrToStructure(pElem, typeof(ELEMDESC));
                string pname = (i + 1 < got) ? names[i + 1] : ("arg" + i);
                string flags = ParamFlags(elem.desc.paramdesc.wParamFlags);
                ps.Add(flags + TypeName(info, elem.tdesc) + " " + pname);
            }

            sb.AppendLine("  " + prefix + TypeName(info, f.elemdescFunc.tdesc) + " " + name +
                          "(" + string.Join(", ", ps.ToArray()) + ")   [id 0x" + f.memid.ToString("X") + "]");
            if (!string.IsNullOrEmpty(doc)) sb.AppendLine("      // " + doc);
        }
        finally { info.ReleaseFuncDesc(pFunc); }
    }

    private static string ParamFlags(PARAMFLAG f)
    {
        var s = "";
        if ((f & PARAMFLAG.PARAMFLAG_FIN) != 0) s += "in ";
        if ((f & PARAMFLAG.PARAMFLAG_FOUT) != 0) s += "out ";
        if ((f & PARAMFLAG.PARAMFLAG_FRETVAL) != 0) s += "retval ";
        if ((f & PARAMFLAG.PARAMFLAG_FOPT) != 0) s += "optional ";
        return s;
    }

    private static string Kind(TYPEKIND k)
    {
        switch (k)
        {
            case TYPEKIND.TKIND_ENUM: return "enum";
            case TYPEKIND.TKIND_RECORD: return "struct";
            case TYPEKIND.TKIND_MODULE: return "module";
            case TYPEKIND.TKIND_INTERFACE: return "interface";
            case TYPEKIND.TKIND_DISPATCH: return "dispinterface";
            case TYPEKIND.TKIND_COCLASS: return "coclass";
            case TYPEKIND.TKIND_ALIAS: return "typedef";
            case TYPEKIND.TKIND_UNION: return "union";
            default: return k.ToString();
        }
    }

    private static string TypeName(ITypeInfo info, TYPEDESC td)
    {
        var vt = (VarEnum)td.vt;
        switch (vt)
        {
            case VarEnum.VT_PTR:
                {
                    var inner = (TYPEDESC)Marshal.PtrToStructure(td.lpValue, typeof(TYPEDESC));
                    return TypeName(info, inner) + "*";
                }
            case VarEnum.VT_SAFEARRAY:
                {
                    var inner = (TYPEDESC)Marshal.PtrToStructure(td.lpValue, typeof(TYPEDESC));
                    return "SAFEARRAY(" + TypeName(info, inner) + ")";
                }
            case VarEnum.VT_USERDEFINED:
                {
                    try
                    {
                        int href = td.lpValue.ToInt32();
                        ITypeInfo refInfo;
                        info.GetRefTypeInfo(href, out refInfo);
                        string n, d, h;
                        int c;
                        refInfo.GetDocumentation(-1, out n, out d, out c, out h);
                        return n;
                    }
                    catch { return "USERDEFINED"; }
                }
            case VarEnum.VT_VOID: return "void";
            case VarEnum.VT_HRESULT: return "HRESULT";
            case VarEnum.VT_BSTR: return "BSTR";
            case VarEnum.VT_BOOL: return "VARIANT_BOOL";
            case VarEnum.VT_I2: return "short";
            case VarEnum.VT_I4: return "long";
            case VarEnum.VT_INT: return "int";
            case VarEnum.VT_UINT: return "unsigned int";
            case VarEnum.VT_UI1: return "byte";
            case VarEnum.VT_UI2: return "unsigned short";
            case VarEnum.VT_UI4: return "unsigned long";
            case VarEnum.VT_I8: return "int64";
            case VarEnum.VT_UI8: return "uint64";
            case VarEnum.VT_R4: return "float";
            case VarEnum.VT_R8: return "double";
            case VarEnum.VT_CY: return "CURRENCY";
            case VarEnum.VT_DATE: return "DATE";
            case VarEnum.VT_VARIANT: return "VARIANT";
            case VarEnum.VT_DISPATCH: return "IDispatch";
            case VarEnum.VT_UNKNOWN: return "IUnknown";
            default: return vt.ToString();
        }
    }
}
'@

$resolved = (Resolve-Path -LiteralPath $Path).Path
$text = [TypeLibDumper]::Dump($resolved)

if ($OutFile) {
    $dir = Split-Path -Parent $OutFile
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    Set-Content -LiteralPath $OutFile -Value $text -Encoding utf8
    "wrote $OutFile ($($text.Length) chars)"
} else {
    $text
}
