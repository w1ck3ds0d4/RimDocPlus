using Xunit;

namespace RimDoc.PatchProbe.Tests;

/// <summary>
/// What the probe says about a patch, given a game and a mod it can read.
/// </summary>
public sealed class ProbeTests
{
    private static PatchReport Only(Fixture fixture, string mod)
    {
        var report = Program.Probe(new Request(fixture.Managed, [mod]));
        return Assert.Single(report.Patches);
    }

    [Fact]
    public void A_method_the_target_inherits_is_not_a_missing_one()
    {
        // The case that made this project exist. Allow Tool patches
        // Designator_PlantsCut.IconReverseDesignating, which RimWorld declares two steps up
        // on Verse.Designator. Harmony resolves a target with AccessTools.Method, which
        // searches base types, so the patch applies; the probe read declared methods only
        // and called it dead, and the app repeated that to the reader as a fault.
        using var fixture = Fixture.Create();
        fixture.WriteGame(
            ("Verse.Base", null, ["MovedMethod"]),
            ("RimWorld.Middle", "Verse.Base", []),
            ("RimWorld.Leaf", "RimWorld.Middle", [])
        );
        var mod = fixture.WriteMod("Mod.dll", "LeafPatch", "RimWorld.Leaf", "MovedMethod");

        var patch = Only(fixture, mod);

        Assert.Equal("ok", patch.Verdict);
        Assert.Contains("inherits", patch.Detail);
        Assert.Contains("Verse.Base", patch.Detail);
    }

    [Fact]
    public void A_method_on_the_target_itself_is_fine()
    {
        using var fixture = Fixture.Create();
        fixture.WriteGame(("RimWorld.Thing", null, ["Tick"]));
        var mod = fixture.WriteMod("Mod.dll", "TickPatch", "RimWorld.Thing", "Tick");

        Assert.Equal("ok", Only(fixture, mod).Verdict);
    }

    [Fact]
    public void A_method_no_type_has_cannot_be_patched()
    {
        using var fixture = Fixture.Create();
        fixture.WriteGame(("RimWorld.Thing", null, ["Tick"]));
        var mod = fixture.WriteMod("Mod.dll", "GonePatch", "RimWorld.Thing", "Vanished");

        var patch = Only(fixture, mod);

        Assert.Equal("missing-method", patch.Verdict);
        Assert.Contains("cannot apply", patch.Detail);
        Assert.Empty(patch.MovedTo);
    }

    [Fact]
    public void A_method_that_moved_to_an_unrelated_type_says_where_it_went()
    {
        // Different from inheritance: the target does not descend from the type that has it
        // now, so the patch really is dead, and where it went is the useful part.
        using var fixture = Fixture.Create();
        fixture.WriteGame(
            ("RimWorld.Thing", null, []),
            ("RimWorld.Somewhere", null, ["Relocated"])
        );
        var mod = fixture.WriteMod("Mod.dll", "MovedPatch", "RimWorld.Thing", "Relocated");

        var patch = Only(fixture, mod);

        Assert.Equal("missing-method", patch.Verdict);
        Assert.Equal(["RimWorld.Somewhere"], patch.MovedTo);
        Assert.Contains("looks like it moved", patch.Detail);
    }

    [Fact]
    public void A_guarded_patch_is_reported_as_one_the_mod_already_knows_about()
    {
        // A static Prepare() is a mod saying it decides at run time whether to apply. That
        // is a different report from a mod that does not know its target is gone.
        using var fixture = Fixture.Create();
        fixture.WriteGame(("RimWorld.Thing", null, []));
        var mod = fixture.WriteMod(
            "Mod.dll",
            "GuardedPatch",
            "RimWorld.Thing",
            "Vanished",
            withPrepare: true
        );

        Assert.Equal("missing-method-guarded", Only(fixture, mod).Verdict);
    }

    [Fact]
    public void A_patch_on_another_mods_type_is_not_breakage()
    {
        // Very common and entirely normal: mods patch each other. The probe cannot see the
        // other mod's assembly, and saying nothing is the honest answer.
        using var fixture = Fixture.Create();
        fixture.WriteGame(("RimWorld.Thing", null, ["Tick"]));
        var mod = fixture.WriteMod("Mod.dll", "ForeignPatch", "SomeOtherMod.Thing", "Tick");

        Assert.Equal("foreign-type", Only(fixture, mod).Verdict);
    }

    [Fact]
    public void An_unreadable_assembly_is_named_rather_than_failing_the_run()
    {
        // One mod on the reference install ships a DLL whose name is mojibake and which
        // Cecil refuses. The other 225 still have to be reported.
        using var fixture = Fixture.Create();
        fixture.WriteGame(("RimWorld.Thing", null, ["Tick"]));
        var good = fixture.WriteMod("Good.dll", "TickPatch", "RimWorld.Thing", "Tick");
        var bad = Path.Combine(fixture.Mods, "Broken.dll");
        File.WriteAllText(bad, "not an assembly");

        var report = Program.Probe(new Request(fixture.Managed, [good, bad]));

        Assert.Single(report.Patches);
        Assert.Equal([bad], report.AssembliesUnreadable);
    }

    [Fact]
    public void A_cycle_in_a_base_chain_does_not_hang_the_walk()
    {
        // Cecil will happily read a hierarchy that loops. The walk is capped so a malformed
        // assembly costs a wrong answer rather than a process that never returns.
        using var fixture = Fixture.Create();
        fixture.WriteGame(("A.One", "A.Two", []), ("A.Two", "A.One", []));
        var mod = fixture.WriteMod("Mod.dll", "LoopPatch", "A.One", "Nothing");

        Assert.Equal("missing-method", Only(fixture, mod).Verdict);
    }
}
