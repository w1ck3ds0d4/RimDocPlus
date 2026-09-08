using Mono.Cecil;

namespace RimDoc.PatchProbe.Tests;

/// <summary>
/// A game and a mod, written as assemblies the probe can read.
/// </summary>
/// <remarks>
/// The probe reads metadata and never loads anything, so a fixture only has to be metadata.
/// These are built with Cecil in a temp folder rather than checked in as binaries: a binary
/// fixture is a thing nobody can read the diff of, and the whole point of a case here is
/// that the shape being tested is visible in the test.
///
/// Harmony is not referenced. The probe recognises a patch class by the *name* of the
/// attribute on it, so a type called HarmonyPatch declared in the fixture is exactly as
/// real to it as the one from HarmonyLib.
/// </remarks>
internal sealed class Fixture : IDisposable
{
    public string Root { get; }
    public string Managed => Path.Combine(Root, "Managed");
    public string Mods => Path.Combine(Root, "Mods");

    private Fixture(string root)
    {
        Root = root;
        Directory.CreateDirectory(Managed);
        Directory.CreateDirectory(Mods);
    }

    public static Fixture Create() =>
        new(Directory.CreateTempSubdirectory("patchprobe-test-").FullName);

    /// <summary>
    /// Write a game assembly whose types are described as name, base type, and methods.
    /// </summary>
    public void WriteGame(params (string Type, string? Base, string[] Methods)[] types)
    {
        var asm = AssemblyDefinition.CreateAssembly(
            new AssemblyNameDefinition("Assembly-CSharp", new Version(1, 0)),
            "Assembly-CSharp",
            ModuleKind.Dll
        );

        var defined = new Dictionary<string, TypeDefinition>(StringComparer.Ordinal);
        foreach (var (name, _, methods) in types)
        {
            var at = name.LastIndexOf('.');
            var type = new TypeDefinition(
                at < 0 ? "" : name[..at],
                at < 0 ? name : name[(at + 1)..],
                TypeAttributes.Public | TypeAttributes.Class,
                asm.MainModule.TypeSystem.Object
            );
            foreach (var method in methods)
            {
                type.Methods.Add(
                    new MethodDefinition(
                        method,
                        MethodAttributes.Public,
                        asm.MainModule.TypeSystem.Void
                    )
                );
            }
            defined[name] = type;
            asm.MainModule.Types.Add(type);
        }

        // Bases in a second pass, so a type may extend one declared after it.
        foreach (var (name, baseName, _) in types)
        {
            if (baseName is not null && defined.TryGetValue(baseName, out var parent))
            {
                defined[name].BaseType = parent;
            }
        }

        asm.Write(Path.Combine(Managed, "Assembly-CSharp.dll"));
    }

    /// <summary>
    /// Write a mod assembly holding one Harmony patch class.
    /// </summary>
    /// <param name="withPrepare">
    /// Gives the patch class a static Prepare(), which is how a mod says it decides at run
    /// time whether to apply. The probe reports those differently, because a mod that
    /// guards a patch already knows the target may not be there.
    /// </param>
    public string WriteMod(
        string fileName,
        string patchClass,
        string targetType,
        string targetMethod,
        string kind = "HarmonyPostfix",
        bool withPrepare = false
    )
    {
        var asm = AssemblyDefinition.CreateAssembly(
            new AssemblyNameDefinition(Path.GetFileNameWithoutExtension(fileName), new Version(1, 0)),
            Path.GetFileNameWithoutExtension(fileName),
            ModuleKind.Dll
        );
        var module = asm.MainModule;

        var attributeBase = module.ImportReference(typeof(Attribute));
        var harmonyPatch = new TypeDefinition(
            "HarmonyLib",
            "HarmonyPatch",
            TypeAttributes.Public | TypeAttributes.Class,
            attributeBase
        );
        var ctor = new MethodDefinition(
            ".ctor",
            MethodAttributes.Public | MethodAttributes.RTSpecialName | MethodAttributes.SpecialName,
            module.TypeSystem.Void
        );
        ctor.Parameters.Add(new ParameterDefinition(module.TypeSystem.String));
        ctor.Parameters.Add(new ParameterDefinition(module.TypeSystem.String));
        harmonyPatch.Methods.Add(ctor);
        module.Types.Add(harmonyPatch);

        var kindAttribute = new TypeDefinition(
            "HarmonyLib",
            kind,
            TypeAttributes.Public | TypeAttributes.Class,
            attributeBase
        );
        var kindCtor = new MethodDefinition(
            ".ctor",
            MethodAttributes.Public | MethodAttributes.RTSpecialName | MethodAttributes.SpecialName,
            module.TypeSystem.Void
        );
        kindAttribute.Methods.Add(kindCtor);
        module.Types.Add(kindAttribute);

        var patch = new TypeDefinition(
            "TestMod",
            patchClass,
            TypeAttributes.Public | TypeAttributes.Class,
            module.TypeSystem.Object
        );
        // The probe reads the target off a class-level [HarmonyPatch("Type", "Method")].
        var declaration = new CustomAttribute(ctor);
        declaration.ConstructorArguments.Add(
            new CustomAttributeArgument(module.TypeSystem.String, targetType)
        );
        declaration.ConstructorArguments.Add(
            new CustomAttributeArgument(module.TypeSystem.String, targetMethod)
        );
        patch.CustomAttributes.Add(declaration);

        var patchMethod = new MethodDefinition(
            "Apply",
            MethodAttributes.Public | MethodAttributes.Static,
            module.TypeSystem.Void
        );
        patchMethod.CustomAttributes.Add(new CustomAttribute(kindCtor));
        patch.Methods.Add(patchMethod);

        if (withPrepare)
        {
            patch.Methods.Add(
                new MethodDefinition(
                    "Prepare",
                    MethodAttributes.Public | MethodAttributes.Static,
                    module.TypeSystem.Boolean
                )
            );
        }

        module.Types.Add(patch);

        var path = Path.Combine(Mods, fileName);
        asm.Write(path);
        return path;
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(Root, recursive: true);
        }
        catch (IOException)
        {
            // A locked file on a build agent is not a test failure.
        }
    }
}
