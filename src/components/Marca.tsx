/**
 * The Wawitas mark: a paw whose central pad is a heart, with a dog's head inside.
 *
 * Reconstructed as SVG from the organisation's Facebook profile image so it can
 * be recoloured, used as a favicon, a list bullet, a section divider, or a
 * watermark — none of which a raster export supports.
 *
 * This is a working reconstruction. If the original vector ever surfaces from
 * whoever designed the logo, replace the paths below with it. Pure markup, no
 * state — a Server Component, so it costs nothing on the client bundle.
 */

interface MarcaProps {
  size?: number;
  /** Any CSS colour. Defaults to the brand jade. */
  color?: string;
  /** Decorative marks are hidden from assistive tech; named ones are not. */
  title?: string;
  className?: string;
}

export function Marca({ size = 48, color = 'var(--jade)', title, className }: MarcaProps) {
  return (
    <svg
      width={size}
      viewBox="0 0 200 232"
      fill={color}
      style={{ stroke: color }}
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : 'true'}
    >
      {/* toe pads */}
      <ellipse cx="41" cy="47" rx="17.5" ry="25" transform="rotate(-20 41 47)" />
      <ellipse cx="80" cy="29" rx="18" ry="27" />
      <ellipse cx="120" cy="29" rx="18" ry="27" />
      <ellipse cx="159" cy="47" rx="17.5" ry="25" transform="rotate(20 159 47)" />

      {/* the heart that replaces the main pad */}
      <path
        fill="none"
        strokeWidth="17"
        strokeLinejoin="round"
        d="M100 220C58 189 24 156 24 122c0-24 18-42 41-42 15 0 28 8 35 21 7-13 20-21 35-21 23 0 41 18 41 42 0 34-34 67-76 98Z"
      />

      {/* the dog, in profile, inside the heart */}
      <path
        stroke="none"
        d="M62 190C55 175 55 155 63 143c5-10 13-17 22-21-4-11-6-21-1-26 6-4 14 1 18 11 5 6 10 11 15 14 10 3 21 8 29 15 6 5 4 12-3 13h-11c-4 7-11 12-19 14l-4 11c-3 10-11 16-20 16Z"
      />
    </svg>
  );
}
