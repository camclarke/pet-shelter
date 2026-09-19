/**
 * The Wawitas mark: a paw whose central pad is a heart, with a dog's head
 * inside it.
 *
 * This is the ORGANISATION'S OWN ARTWORK, supplied by the shelter as a vector
 * and adopted on 2026-09-19. It replaces a hand-drawn reconstruction that had
 * stood in since 2026-08-02 — the note there invited exactly this swap if the
 * original ever surfaced.
 *
 * Two things were done to the supplied file and both matter if it is ever
 * re-imported. It arrived as an INVERTED trace: a white logo cut as a hole out
 * of a full-canvas black rectangle, so recolouring its fill would have painted
 * a rectangle with a logo-shaped void. The canvas rectangle is gone, and the
 * remaining contours fill correctly under fill-rule:nonzero because a trace
 * winds a hole counter to its container. It was also cropped to the artwork —
 * the supplied canvas carried ~39% empty width, which at a given `size` would
 * have rendered the mark barely half as tall as the drawing it replaced.
 *
 * Pure markup, no state — a Server Component, so it costs the client bundle
 * nothing. It ships in the header and footer of every page.
 */

interface BrandProps {
  /** Rendered WIDTH in px. Height follows the artwork's 0.9297 ratio. */
  size?: number;
  /**
   * Any CSS colour. Defaults to the brand mark token, which is jade on paper
   * and jade-light at night — see --brand-mark in globals.css.
   */
  color?: string;
  /** Decorative marks are hidden from assistive tech; named ones are not. */
  title?: string;
  className?: string;
}

export function Brand({ size = 48, color = 'var(--brand-mark)', title, className }: BrandProps) {
  return (
    <svg
      width={size}
      viewBox="0 0 777 835"
      fill={color}
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : 'true'}
    >
      <g transform="translate(-298.76,845) scale(0.1,-0.1)">
        <path d="M8400 8429c354-98 604-465 651-957 27-283-33-617-153-856-51-101-163-258-236-329-187-185-368-267-587-267-215 0-386 78-547 248-142 150-219 297-281 537-30 115-31 129-31 325-1 160 3 223 17 287 64 299 190 552 367 737 135 142 283 234 445 277 100 26 258 25 355-2zm-2644-73c266-98 492-339 624-666 89-219 121-432 102-663-49-583-395-992-837-991-122 1-199 20-320 78-115 55-199 119-284 215-156 178-252 378-313 656-32 147-32 445 1 595 79 367 251 618 506 742 114 54 186 68 330 64 99-3 133-8 191-30zm4602-1436c71-10 175-55 232-100 51-41 107-127 138-214 23-62 26-87 26-196-1-145-15-217-74-357-54-131-136-249-255-369-193-195-379-281-591-272-86 4-110 9-168 36-189 88-285 274-273 522 15 282 176 574 421 764 133 103 269 167 396 185 76 12 77 12 148 1zm-6763-11c275-51 550-270 693-554 73-144 109-324 93-470-21-195-124-341-298-422-71-33-88-37-184-41-139-6-229 14-358 78-191 96-362 279-462 495-157 341-99 691 140 844 108 69 244 95 376 70zm1776-1339c386-39 763-198 1079-455 104-84 232-209 378-367l53-57 37 41c20 22 41 47 45 54 17 29 268 251 377 333 133 100 242 167 398 246 333 166 678 236 999 200 225-25 344-60 540-159 134-67 232-136 336-235 476-454 634-1169 422-1906-128-444-399-907-845-1440-273-326-762-781-1145-1065-464-344-1026-660-1174-660-171 0-1002 500-1411 849-195 166-440 399-550 522l-59 65 97 28c111 31 267 103 374 171 191 124 394 338 518 550 83 139 116 219 154 372 20 78 48 174 62 215 116 322 354 591 648 733 155 74 252 99 396 99 98 0 135-5 245-33 108-28 141-33 200-28 133 11 340 98 559 236 151 95 177 102 243 70 41-20 53-34 81-89 49-98 73-206 79-355 14-335-95-515-573-941-179-159-266-249-324-336l-38-58-40 83c-35 72-67 159-126 352l-16 50 5-67c8-105 48-244 120-421 100-241 138-369 132-438-6-69-27-103-81-132-35-18-57-21-141-20-84 1-119 7-218 38-295 89-479 215-614 418-38 56-77 127-87 157-28 77-32 44-6-37 43-131 161-304 275-403 120-104 300-198 464-242l84-22-7-66c-9-105-53-262-119-425-68-170-80-239-52-298 35-73 112-74 257-1 381 191 948 668 1342 1129 113 132 252 305 296 369 8 12 45 64 81 116 263 376 460 786 544 1132 44 184 55 275 55 474 0 195-23 346-73 485-112 308-297 523-562 654-201 99-392 135-607 115-414-40-826-247-1167-589-154-154-337-375-390-469-14-26-64 22-235 223-206 244-316 357-446 462-187 151-340 236-551 307-377 127-702 111-1010-51-117-61-207-129-315-238-187-189-285-385-336-675-19-110-16-427 6-568 87-559 413-1151 932-1692l93-96-47-17c-67-23-206-57-234-57-48 1-353 303-534 530-121 151-182 238-272 388-421 701-485 1486-171 2102 205 403 556 682 1002 796 186 47 383 62 568 44z" />
      </g>
    </svg>
  );
}
