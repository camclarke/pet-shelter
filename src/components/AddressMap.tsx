/**
 * The CROQUIS UBICACIÓN map: an OpenStreetMap view of the service area where an
 * adoption applicant may mark their home, and where an admin sees that mark.
 *
 * ⚠️ Import this module ONLY through `LazyAddressMap`. Leaflet touches `window`
 * when it loads, and the dynamic import is what keeps Leaflet, its stylesheet
 * and every tile request off every page until a person taps to open the map.
 * Nobody who skips the map ever contacts the tile server.
 *
 * The pin is a circle, not Leaflet's default marker: the default marker's
 * image URLs break under a bundler, and a circle needs no image at all.
 * A pin is rounded to 4 decimals before it leaves this component, the same
 * rounding `validateHome` applies and the rules check.
 */

'use client';

import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { useEffect, useRef } from 'react';
import { SHELTER } from '@/config/shelter';
import { roundPin4, type PinCoordinates } from '@/lib/applications';
import { t } from '@/i18n';

export interface AddressMapProps {
  pin: PinCoordinates | null;
  /** Absent for a read-only map (the admin view): a tap then does nothing. */
  onPin?: (pin: PinCoordinates) => void;
  /** Called once, when the tiles cannot be fetched at all. */
  onFailed?: () => void;
  /** The map's accessible name. */
  label: string;
}

/** Tiles that must fail, with none loaded, before the map is declared unusable. */
const TILE_FAILURES_BEFORE_GIVING_UP = 3;

export default function AddressMap({ pin, onPin, onFailed, label }: AddressMapProps) {
  const box = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const marker = useRef<L.CircleMarker | null>(null);
  const onPinRef = useRef(onPin);
  onPinRef.current = onPin;
  const onFailedRef = useRef(onFailed);
  onFailedRef.current = onFailed;
  const readOnly = onPin === undefined;
  // The pin the map opened on; later pins only move the marker.
  const initialPin = useRef(pin);

  useEffect(() => {
    if (!box.current) return;
    const { map: config, bounds } = SHELTER;
    const start = initialPin.current ?? config.center;
    const created = L.map(box.current, {
      center: [start.latitude, start.longitude],
      zoom: initialPin.current ? 17 : config.zoom,
      minZoom: config.minZoom,
      maxZoom: config.maxZoom,
      // A little slack past the service box, so a home near its edge can be
      // centred; a mark outside it is still refused by validateHome.
      maxBounds: L.latLngBounds([bounds.minLat, bounds.minLng], [bounds.maxLat, bounds.maxLng]).pad(0.1),
      maxBoundsViscosity: 1,
      // Leaflet's own zoom control is titled in English.
      zoomControl: false,
    });
    L.control
      .zoom({ zoomInTitle: t.applicationSteps.mapZoomIn, zoomOutTitle: t.applicationSteps.mapZoomOut })
      .addTo(created);

    let loaded = 0;
    let failed = 0;
    let gaveUp = false;
    L.tileLayer(config.tileUrl, { attribution: config.attribution, maxZoom: config.maxZoom })
      .on('tileload', () => {
        loaded += 1;
      })
      .on('tileerror', () => {
        failed += 1;
        if (!gaveUp && loaded === 0 && failed >= TILE_FAILURES_BEFORE_GIVING_UP) {
          gaveUp = true;
          onFailedRef.current?.();
        }
      })
      .addTo(created);

    if (!readOnly) {
      created.on('click', (event: L.LeafletMouseEvent) => {
        onPinRef.current?.(roundPin4({ latitude: event.latlng.lat, longitude: event.latlng.lng }));
      });
    }

    map.current = created;
    return () => {
      created.remove();
      map.current = null;
      marker.current = null;
    };
    // Built once per mount: the pin is synced by the effect below.
  }, [readOnly]);

  useEffect(() => {
    const current = map.current;
    if (!current) return;
    if (!pin) {
      marker.current?.remove();
      marker.current = null;
      return;
    }
    const point: L.LatLngExpression = [pin.latitude, pin.longitude];
    if (marker.current) marker.current.setLatLng(point);
    else {
      marker.current = L.circleMarker(point, {
        radius: 10,
        color: '#12463b',
        weight: 3,
        fillColor: '#31907a',
        fillOpacity: 0.9,
        interactive: false,
      }).addTo(current);
    }
  }, [pin]);

  return <div ref={box} className="address-map" aria-label={label} />;
}
