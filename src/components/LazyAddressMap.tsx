/**
 * Loads `AddressMap` (and with it Leaflet, its stylesheet and the first tile
 * request) only when this component mounts. Render it only after a person
 * asked for the map. A failed download is reported like failed tiles, through
 * `onFailed`, so the caller shows one message for both.
 */

'use client';

import { useEffect, useRef, useState, type ComponentType } from 'react';
import type { AddressMapProps } from './AddressMap';

export interface LazyAddressMapProps extends AddressMapProps {
  /** Shown while the map's code downloads. */
  loadingText: string;
  /** Replaces `import('./AddressMap')`; tests pass a fake. */
  load?: () => Promise<{ default: ComponentType<AddressMapProps> }>;
}

export function LazyAddressMap({ loadingText, load, ...props }: LazyAddressMapProps) {
  const [View, setView] = useState<ComponentType<AddressMapProps> | null>(null);
  const onFailed = useRef(props.onFailed);
  onFailed.current = props.onFailed;

  useEffect(() => {
    let live = true;
    (load ?? (() => import('./AddressMap')))()
      .then((module) => {
        if (live) setView(() => module.default);
      })
      .catch(() => {
        if (live) onFailed.current?.();
      });
    return () => {
      live = false;
    };
  }, [load]);

  if (!View) {
    return (
      <div className="address-map address-map--loading" role="status">
        {loadingText}
      </div>
    );
  }
  return <View {...props} />;
}
