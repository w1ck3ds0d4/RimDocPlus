/**
 * One icon per tab, drawn inline.
 *
 * Inline because a tab strip is the last thing that should wait on a network request or a
 * font, and because these need to take their colour from the tab they sit in. Every path is
 * on a 16 unit grid with a 1.6 stroke, so they hold together at the 15px they are drawn at.
 *
 * The label is what the tab means; the icon is what makes it findable once the label has to
 * go. So each one is drawn for recognition at a glance rather than for detail.
 */
export type TabName = "home" | "doctor" | "session" | "saves" | "packs" | "order" | "library" | "settings";

const PATHS: Record<TabName, React.ReactNode> = {
  // A roof over a door.
  home: <path d="M2.2 7.2 8 2.4l5.8 4.8V13a.8.8 0 0 1-.8.8H3a.8.8 0 0 1-.8-.8Z" />,
  // The cross the whole app is named for.
  doctor: <path d="M8 3v10M3 8h10" />,
  // A page with lines: the log.
  session: (
    <>
      <path d="M3.6 2.4h8.8v11.2H3.6Z" />
      <path d="M5.8 5.6h4.4M5.8 8h4.4M5.8 10.4h2.6" />
    </>
  ),
  // A floppy disk, which is still what a save looks like.
  saves: (
    <>
      <path d="M3 3h7.4L13 5.6V13H3Z" />
      <path d="M5.4 3v3.4h4V3M5.4 13v-3.6h5.2V13" />
    </>
  ),
  // Stacked layers: a list of lists.
  packs: (
    <>
      <path d="M8 2.2 14 5 8 7.8 2 5Z" />
      <path d="M2 8.4 8 11.2l6-2.8M2 11.4 8 14.2l6-2.8" />
    </>
  ),
  // Ordered rows, the top one marked.
  order: (
    <>
      <path d="M2.6 4.2h10.8M2.6 8h10.8M2.6 11.8h10.8" />
      <path d="M2.6 4.2h3.4" strokeWidth="3" />
    </>
  ),
  // Books on a shelf.
  library: (
    <>
      <path d="M3 2.8h2.6v10.4H3ZM6.6 2.8h2.6v10.4H6.6Z" />
      <path d="m10.4 3.4 2.5.6-2.2 9.4-2.5-.6" />
    </>
  ),
  // Sliders, not a cog: this app's settings are choices rather than machinery.
  settings: (
    <>
      <path d="M3 4.6h10M3 11.4h10" />
      <circle cx="6.2" cy="4.6" r="1.6" />
      <circle cx="10.4" cy="11.4" r="1.6" />
    </>
  ),
};

export function TabIcon({ name }: { name: TabName }) {
  return (
    <svg
      className="tab-icon"
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
