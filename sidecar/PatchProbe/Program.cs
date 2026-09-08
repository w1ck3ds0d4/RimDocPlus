using System.Text.Json;
using System.Text.Json.Serialization;
using Mono.Cecil;
using Mono.Cecil.Cil;

namespace RimDoc.PatchProbe;

/// <summary>What the caller asks for: where the game is, and which assemblies to read.</summary>
/// <remarks>
/// The paths are given rather than discovered. This process has no opinion about where a
/// RimWorld install lives, which keeps the discovery in one place and makes the probe
/// runnable by hand against a copied folder.
/// </remarks>
public sealed record Request(
    [property: JsonPropertyName("managed")] string Managed,
    [property: JsonPropertyName("assemblies")] string[] Assemblies
);

/// <summary>One Harmony patch declaration, and whether what it patches still exists.</summary>
public sealed record PatchReport(
    [property: JsonPropertyName("assembly")] string Assembly,
    [property: JsonPropertyName("patchClass")] string PatchClass,
    [property: JsonPropertyName("targetType")] string? TargetType,
    [property: JsonPropertyName("targetMethod")] string? TargetMethod,
    [property: JsonPropertyName("kinds")] string[] Kinds,
    [property: JsonPropertyName("verdict")] string Verdict,
    [property: JsonPropertyName("detail")] string Detail,
    /// <summary>Game types that do have a method of this name, when the declared one does not.</summary>
    [property: JsonPropertyName("movedTo")] string[] MovedTo
);

public sealed record Report(
    [property: JsonPropertyName("gameAssemblies")] int GameAssemblies,
    [property: JsonPropertyName("gameTypes")] int GameTypes,
    [property: JsonPropertyName("assembliesRead")] int AssembliesRead,
    [property: JsonPropertyName("assembliesUnreadable")] string[] AssembliesUnreadable,
    [property: JsonPropertyName("patches")] PatchReport[] Patches
);

/// <summary>
/// Serialisation without reflection, so the published binary can be trimmed.
///
/// The shapes are known at compile time, which is what lets the trimmer keep only what is
/// actually used and the executable stay a few megabytes rather than seventy.
/// </summary>
[JsonSourceGenerationOptions(WriteIndented = false)]
[JsonSerializable(typeof(Request))]
[JsonSerializable(typeof(Report))]
internal sealed partial class ProbeJson : JsonSerializerContext;

/// <summary>
/// Finds the assemblies a mod references, and gives up quietly when it cannot.
/// </summary>
/// <remarks>
/// Cecil needs a reference resolved to decode an attribute's arguments, and Cecil's own
/// resolver throws when it cannot find one. A mod referencing a library that is not beside
/// it is ordinary: the mod that ships Harmony may be disabled, or the reference may be to
/// another mod entirely. Throwing there abandoned the whole run over one absent DLL.
/// </remarks>
internal sealed class ProbeResolver : BaseAssemblyResolver
{
    private readonly Dictionary<string, AssemblyDefinition?> cache = new(StringComparer.OrdinalIgnoreCase);

    public override AssemblyDefinition? Resolve(AssemblyNameReference name)
    {
        if (cache.TryGetValue(name.Name, out var known))
        {
            return known;
        }

        AssemblyDefinition? found;
        try
        {
            found = base.Resolve(name);
        }
        catch (Exception)
        {
            found = null;
        }

        cache[name.Name] = found;
        return found;
    }

    protected override void Dispose(bool disposing)
    {
        foreach (var assembly in cache.Values)
        {
            assembly?.Dispose();
        }
        cache.Clear();
        base.Dispose(disposing);
    }
}

public static class Program
{
    /// <summary>Harmony's own annotations. A class carrying one of these is a patch class.</summary>
    /// <summary>
    /// How many game types may hold a name before it stops being evidence of a move.
    /// </summary>
    /// <remarks>
    /// A method on one or two types is a rename or a relocation worth naming. A method on
    /// twenty is a name everything has, and listing a few of them would dress noise up as
    /// a lead.
    /// </remarks>
    private const int MaxMovedTo = 3;

    private static readonly string[] PatchKinds =
    [
        "HarmonyPrefix",
        "HarmonyPostfix",
        "HarmonyTranspiler",
        "HarmonyFinalizer",
        "HarmonyReversePatch",
    ];

    public static int Main()
    {
        try
        {
            var json = Console.In.ReadToEnd();
            var request = JsonSerializer.Deserialize(json, ProbeJson.Default.Request);
            if (request is null)
            {
                return Fail("The request was empty.");
            }

            var report = Probe(request);
            Console.Out.Write(JsonSerializer.Serialize(report, ProbeJson.Default.Report));
            return 0;
        }
        catch (Exception e)
        {
            return Fail(e.Message);
        }
    }

    private static int Fail(string message)
    {
        // stderr, so a caller reading stdout as JSON is never handed prose.
        Console.Error.Write(message);
        return 1;
    }

    private static Report Probe(Request request)
    {
        var game = ReadGameTypes(request.Managed);
        var patches = new List<PatchReport>();
        var unreadable = new List<string>();
        var read = 0;

        using var resolver = new ProbeResolver();
        resolver.AddSearchDirectory(request.Managed);
        var parameters = new ReaderParameters { AssemblyResolver = resolver };

        foreach (var path in request.Assemblies)
        {
            // Beside the assembly first: a mod's own Assemblies folder is where the copy of
            // Harmony it was built against lives.
            var beside = Path.GetDirectoryName(path);
            if (beside is not null)
            {
                resolver.AddSearchDirectory(beside);
            }

            ModuleDefinition module;
            try
            {
                module = ModuleDefinition.ReadModule(path, parameters);
            }
            catch
            {
                // A mod can ship a native DLL, a corrupt one, or one built for a runtime
                // Cecil will not open. One unreadable assembly is not a reason to abandon
                // the other thousand, and saying which ones were skipped is more honest
                // than a total that quietly excludes them.
                unreadable.Add(path);
                continue;
            }

            read++;
            using (module)
            {
                foreach (var type in AllTypes(module))
                {
                    PatchReport? found;
                    try
                    {
                        found = Inspect(type, game, path);
                    }
                    catch (Exception)
                    {
                        // An attribute this build of Cecil cannot decode. Skipped rather
                        // than guessed at, and rather than taking the assembly with it.
                        continue;
                    }

                    if (found is not null)
                    {
                        patches.Add(found);
                    }
                }
            }
        }

        return new Report(
            game.Assemblies,
            game.Types.Count,
            read,
            [.. unreadable],
            [.. patches]
        );
    }

    /// <summary>Every type the installed game defines, by full name, with its method names.</summary>
    /// <param name="Bases">
    /// Each type's base type, so a lookup can walk the chain the way Harmony does.
    /// </param>
    private sealed record GameSurface(
        int Assemblies,
        Dictionary<string, HashSet<string>> Types,
        Dictionary<string, string> Bases
    );

    private static GameSurface ReadGameTypes(string managed)
    {
        var types = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        var bases = new Dictionary<string, string>(StringComparer.Ordinal);
        var count = 0;

        foreach (var path in Directory.EnumerateFiles(managed, "*.dll"))
        {
            ModuleDefinition module;
            try
            {
                module = ModuleDefinition.ReadModule(path);
            }
            catch
            {
                continue;
            }

            count++;
            using (module)
            {
                foreach (var type in AllTypes(module))
                {
                    // Methods and properties both: Harmony patches a property through its
                    // getter, and the attribute names the property rather than get_Name.
                    var names = new HashSet<string>(StringComparer.Ordinal);
                    foreach (var method in type.Methods)
                    {
                        names.Add(method.Name);
                    }
                    foreach (var property in type.Properties)
                    {
                        names.Add(property.Name);
                    }
                    types[type.FullName] = names;
                    if (type.BaseType is not null)
                    {
                        bases[type.FullName] = type.BaseType.FullName;
                    }
                }
            }
        }

        return new GameSurface(count, types, bases);
    }

    /// <summary>
    /// The type in a chain that declares a method, or null when none of them does.
    /// </summary>
    /// <remarks>
    /// Bounded rather than trusting the chain to end: a malformed or circular hierarchy in
    /// somebody's assembly should cost a wrong answer, not a hang.
    /// </remarks>
    private static string? DeclaringTypeOf(GameSurface game, string type, string method)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var current = type;
        while (seen.Add(current) && seen.Count <= MaxInheritanceDepth)
        {
            if (game.Types.TryGetValue(current, out var names) && names.Contains(method))
            {
                return current;
            }
            if (!game.Bases.TryGetValue(current, out var next))
            {
                return null;
            }
            current = next;
        }
        return null;
    }

    /// <summary>How far up a base chain a target is looked for.</summary>
    /// <remarks>
    /// RimWorld's deepest is about ten. The cap is a guard against a cycle, not a limit
    /// anything real reaches.
    /// </remarks>
    private const int MaxInheritanceDepth = 64;

    /// <summary>Nested types included, since patch classes are very often nested.</summary>
    private static IEnumerable<TypeDefinition> AllTypes(ModuleDefinition module)
    {
        foreach (var type in module.Types)
        {
            yield return type;
            foreach (var nested in Nested(type))
            {
                yield return nested;
            }
        }
    }

    private static IEnumerable<TypeDefinition> Nested(TypeDefinition type)
    {
        foreach (var nested in type.NestedTypes)
        {
            yield return nested;
            foreach (var deeper in Nested(nested))
            {
                yield return deeper;
            }
        }
    }

    private static PatchReport? Inspect(
        TypeDefinition type,
        GameSurface game,
        string assembly
    )
    {
        var kinds = type
            .Methods.SelectMany(m => m.CustomAttributes)
            .Select(a => a.AttributeType.Name)
            .Where(n => PatchKinds.Contains(n))
            .Distinct()
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToArray();

        if (kinds.Length == 0)
        {
            return null;
        }

        // Harmony calls a static Prepare() before applying, and a false return means the
        // class opts out. Mods use it to carry patches for several game versions in one
        // build, so a target that is absent here may be one the mod already knows better
        // than to apply. Reported as guarded rather than counted as broken.
        var conditional = type.Methods.Any(m => m.Name == "Prepare" && m.IsStatic);

        var (targetType, targetMethod, declared) = ReadTarget(type);
        var report = (string verdict, string detail) =>
            new PatchReport(assembly, type.FullName, targetType, targetMethod, kinds, verdict, detail, []);

        if (targetType is null || targetMethod is null)
        {
            // Nothing usable from the attribute. The class may still build its target out
            // of literals, which is metadata even though it is written as code.
            var (codeType, codeMethod) = ReadCodeTarget(type);
            if (codeType is not null && codeMethod is not null)
            {
                targetType = codeType;
                targetMethod = codeMethod;
                declared = true;
            }
        }

        if (!declared)
        {
            // A bare [HarmonyPatch] with a TargetMethod() that computes what to patch at
            // runtime. Nothing here can resolve that without running it, and pretending
            // otherwise would be a guess reported as a fact.
            return report(
                "runtime-only",
                "The target is computed at runtime, so it cannot be checked without launching the game."
            );
        }

        if (targetType is null)
        {
            return report("runtime-only", "No target type is declared on the patch class.");
        }

        if (!game.Types.TryGetValue(targetType, out var methods))
        {
            // Not in the game: very often the patch targets another mod, which is normal
            // and not a fault. Said plainly rather than counted as breakage.
            return report(
                "foreign-type",
                $"{targetType} is not a type the game defines. It is probably another mod's."
            );
        }

        if (targetMethod is null)
        {
            return report("ok", $"{targetType} exists. No single method is named on the class.");
        }

        // Harmony resolves a target with AccessTools.Method, which searches base types.
        // Reading only the declared methods reported a patch as dead when the method it
        // wanted had merely moved up into a base class the target still inherits from:
        // Designator_PlantsCut.IconReverseDesignating is declared on Verse.Designator, two
        // steps up a chain the type still walks, and the patch applies exactly as it always
        // did. Judging the chain is what makes "this patch cannot apply" mean it.
        var declaredOn = DeclaringTypeOf(game, targetType, targetMethod);
        if (declaredOn is not null)
        {
            return report(
                "ok",
                declaredOn == targetType
                    ? $"{targetType}.{targetMethod} exists in this build."
                    : $"{targetType} inherits {targetMethod} from {declaredOn}, which is where Harmony finds it."
            );
        }

        // Where it went, if it went anywhere. A method that moved to another type is a
        // different problem from one that was deleted, and the difference is the whole of
        // what someone would do about it, so it is worth the second lookup.
        //
        // Only when the name is rare enough to mean something. "Tick" is on hundreds of
        // game types, so listing four of them says nothing about where anything moved and
        // reads as a confident answer to a question that was not asked.
        var holders = game
            .Types.Where(pair => pair.Value.Contains(targetMethod))
            .Select(pair => pair.Key)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();
        var elsewhere = holders.Length is > 0 and <= MaxMovedTo ? holders : [];

        return new PatchReport(
            assembly,
            type.FullName,
            targetType,
            targetMethod,
            kinds,
            conditional ? "missing-method-guarded" : "missing-method",
            elsewhere.Length > 0
                ? $"{targetType} has no {targetMethod} in this build. A method of that name is on {string.Join(", ", elsewhere)}, so it looks like it moved."
                : holders.Length > 0
                    ? $"{targetType} has no {targetMethod} in this build. The name is common enough across the game that where it went cannot be guessed from it."
                    : $"{targetType} has no {targetMethod}, and no game type does. This patch cannot apply to this build.",
            elsewhere
        );
    }

    /// <summary>Reflection lookups whose result is a method worth resolving.</summary>
    /// <summary>
    /// How far back from a lookup call its arguments can be.
    /// </summary>
    /// <remarks>
    /// `AccessTools.Method(typeof(Pawn), "Tick")` puts both a handful of instructions before
    /// the call. A window keeps the search on this call's own arguments rather than drifting
    /// into whatever the method was doing beforehand.
    /// </remarks>
    private const int ArgumentWindow = 10;

    private static readonly string[] Lookups =
    [
        "Method",
        "DeclaredMethod",
        "GetMethod",
        "PropertyGetter",
        "PropertySetter",
        "DeclaredPropertyGetter",
        "DeclaredPropertySetter",
    ];

    /// <summary>
    /// The target a TargetMethod() builds, when it builds it out of literals.
    /// </summary>
    /// <remarks>
    /// Harmony lets a patch class compute what it patches, and the usual shape of that is
    /// `AccessTools.Method(typeof(Pawn), "Tick")`. Both halves are constants in the IL, so
    /// they can be read without running anything: a `ldtoken` carrying the type, a `ldstr`
    /// carrying the name, and a call to a lookup that turns them into a method.
    ///
    /// Only that shape. A target assembled from a variable, a loop or another method's
    /// return value stays unreadable, and is left as runtime-only rather than guessed at.
    /// The first pair wins, because a body that looks up several methods is choosing between
    /// them and this cannot say which.
    /// </remarks>
    private static (string? Type, string? Method) ReadCodeTarget(TypeDefinition type)
    {
        var builder = type.Methods.FirstOrDefault(m =>
            m.IsStatic && m.Name is "TargetMethod" && m.HasBody
        );
        if (builder is null)
        {
            return (null, null);
        }

        var code = builder.Body.Instructions;

        for (var i = 0; i < code.Count; i++)
        {
            if (code[i].OpCode != OpCodes.Call && code[i].OpCode != OpCodes.Callvirt)
            {
                continue;
            }
            if (code[i].Operand is not MethodReference call || !Lookups.Contains(call.Name))
            {
                continue;
            }

            // Read the call's arguments by walking back from it, rather than forward from
            // the type. Forward was wrong: it took the first string after the type token,
            // and a method that loads an error message before looking anything up handed
            // back "Multiple CompIngredients fields found" as a method name. The arguments
            // are the values pushed immediately before the call, so that is where to look.
            TypeReference? owner = null;
            string? name = null;
            for (var back = i - 1; back >= 0 && back >= i - ArgumentWindow; back--)
            {
                if (name is null && code[back].OpCode == OpCodes.Ldstr && code[back].Operand is string text)
                {
                    name = text;
                }
                if (owner is null
                    && code[back].OpCode == OpCodes.Ldtoken
                    && code[back].Operand is TypeReference token)
                {
                    owner = token;
                }
                if (owner is not null && name is not null)
                {
                    return (owner.FullName, name);
                }
            }
        }

        return (null, null);
    }

    /// <summary>
    /// The target a class-level [HarmonyPatch] names.
    /// </summary>
    /// <remarks>
    /// Attribute-declared targets only. Harmony also accepts a TargetMethod() that returns
    /// what to patch, and patches registered imperatively through harmony.Patch(...), and
    /// neither is a fact about metadata: both are decided while the game runs. They are
    /// reported as runtime-only rather than resolved, so the count of checked patches never
    /// claims coverage it does not have.
    /// </remarks>
    private static (string? Type, string? Method, bool Declared) ReadTarget(TypeDefinition type)
    {
        string? targetType = null;
        string? targetMethod = null;
        var declared = false;

        foreach (var attribute in type.CustomAttributes)
        {
            if (attribute.AttributeType.Name != "HarmonyPatch")
            {
                continue;
            }

            declared = true;

            foreach (var argument in attribute.ConstructorArguments)
            {
                switch (argument.Value)
                {
                    case TypeReference reference:
                        targetType ??= reference.FullName;
                        break;
                    // The string overloads are (methodName) and (typeName, methodName). A
                    // string holding dots and matching a type is the latter's first half,
                    // which is why the type is taken before the method.
                    case string text when targetType is null && text.Contains('.') && targetMethod is null:
                        targetType = text;
                        break;
                    case string text:
                        targetMethod ??= text;
                        break;
                }
            }

            foreach (var named in attribute.Properties)
            {
                if (named.Name == "declaringType" && named.Argument.Value is TypeReference reference)
                {
                    targetType ??= reference.FullName;
                }

                if (named.Name == "methodName" && named.Argument.Value is string text)
                {
                    targetMethod ??= text;
                }
            }
        }

        return (targetType, targetMethod, declared);
    }
}
