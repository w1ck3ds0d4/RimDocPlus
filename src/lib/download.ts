/** Hand a generated file to the browser. Shared by pack export and repair scripts. */
export function download(filename: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** Filesystem-safe slug for a user-supplied name. */
export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "pack"
  );
}
