'use client';

import { useState } from 'react';
import Link from 'next/link';

import { t } from '@/i18n';
import { DonationSection } from './DonationSection';
import { StockSection } from './StockSection';
import { CookSection } from './CookSection';
import { RationsSection } from './RationsSection';

/**
 * Food, build-order step 13: donations, the pantry, the pot and the day's
 * rations, as four tabs on one screen.
 *
 * Plan §12.6: this is the module used every day, by staff who are not the
 * people entering pets, on a phone in a courtyard. So it is its own screen,
 * one tab is rendered at a time (each loads only its own data), and nothing
 * here depends on a model answering — parsing is an accelerator on the
 * donation tab and the lines can always be typed.
 *
 * ⚠️ Every read and write goes through `firestore.rules`. The food rules are
 * tested with the Rules test API but NOT deployed, so until they are, every tab
 * shows the permission-denied message — that is default-deny working.
 */

type Tab = 'donation' | 'stock' | 'cook' | 'rations';

const TABS: readonly Tab[] = ['donation', 'stock', 'cook', 'rations'];

function tabLabel(tab: Tab): string {
  switch (tab) {
    case 'donation':
      return t.food.tabDonation;
    case 'stock':
      return t.food.tabStock;
    case 'cook':
      return t.food.tabCook;
    case 'rations':
      return t.food.tabRations;
  }
}

export function FoodPanel() {
  const [tab, setTab] = useState<Tab>('donation');

  return (
    <div className="admin">
      <header className="admin__header">
        <div>
          <h1 className="t-title">{t.food.title}</h1>
          <p className="admin__sub">{t.food.sub}</p>
        </div>
        <div className="admin__header-actions">
          <Link href="/admin" className="btn btn--muted">
            {t.food.backToPanel}
          </Link>
        </div>
      </header>

      <nav className="admin-steps food-tabs" aria-label={t.food.title}>
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            className={`admin-steps__item${tab === name ? ' is-current' : ''}`}
            aria-pressed={tab === name}
            onClick={() => setTab(name)}
          >
            {tabLabel(name)}
          </button>
        ))}
      </nav>

      {tab === 'donation' && <DonationSection />}
      {tab === 'stock' && <StockSection />}
      {tab === 'cook' && <CookSection />}
      {tab === 'rations' && <RationsSection />}
    </div>
  );
}

/** A Firestore failure as the words a volunteer can act on. */
export function loadErrorText(caught: unknown): string {
  const code = (caught as { code?: string } | null)?.code;
  return code === 'permission-denied' ? t.food.permissionDenied : t.food.loadFailed;
}
