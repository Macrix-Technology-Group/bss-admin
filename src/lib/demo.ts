/* Demo data for looking at the UI without a database.
 *
 * Switched on by DEMO_DATA=1 in .env. The page reads this instead of opening a connection, so the
 * screen works with the VPN down, the database moved, or nothing provisioned yet.
 *
 * Delete the flag to go back to the real thing — nothing else changes.
 */
import type { Inquiry } from './inquiry';

/* Fixed offsets from "now" rather than hard-coded dates, so the list always looks current and the
   relative times in the UI stay sensible however long this sits unused. */
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

export const DEMO_ROWS: Inquiry[] = [
    {
        id: '1',
        first_name: 'Tomasz', last_name: 'Nowak',
        company: 'PolFresh Distribution Sp. z o.o.',
        email: 't.nowak@polfresh.pl', phone: '+48 61 842 19 03',
        subject: 'Kühllager — 40.000 Positionen pro Tag',
        message:
            'Guten Tag,\n\nwir betreiben ein Hochregallager mit 12.000 Stellplätzen und möchten die ' +
            'Steuerung erneuern. Die bestehende Anlage läuft noch auf einem System von 2009.\n\n' +
            'Können Sie uns ein Angebot für eine WES-Migration machen?\n\n' +
            'Mit freundlichen Grüßen\nTomasz Nowak',
        consent_given: true, privacy_version: '2026-01', locale: 'de',
        status: 'new', assignee: null, notes: null,
        received_at: ago(2), updated_at: ago(2),
    },
    {
        id: '2',
        first_name: 'Sabine', last_name: 'Vogt',
        company: 'Vogt Pharma Logistik GmbH',
        email: 's.vogt@vogt-pharma.de', phone: '+49 621 4470 118',
        subject: 'GDP-konforme Kommissionierung',
        message:
            'Sehr geehrte Damen und Herren,\n\nfür unser neues Distributionszentrum in Mannheim suchen ' +
            'wir eine Lösung zur chargengenauen Kommissionierung unter GDP-Bedingungen. ' +
            'Temperaturbereich 2–8 °C.\n\nWir würden uns über einen Rückruf freuen.',
        consent_given: true, privacy_version: '2026-01', locale: 'de',
        status: 'in_progress', assignee: 'Marek Zuchowski',
        notes: 'Rückruf vereinbart für Donnerstag 14:00. Braucht Referenzen aus der Pharmabranche.',
        received_at: ago(9), updated_at: ago(4),
    },
    {
        id: '3',
        first_name: 'James', last_name: 'Whitfield',
        company: 'Northgate Retail Group',
        email: 'j.whitfield@northgate-retail.co.uk', phone: null,
        subject: 'Kolli Scanner — throughput figures',
        message:
            'Hello,\n\nWe saw the Kolli Scanner on your site. Could you share throughput figures for ' +
            'mixed-carton flows, and whether it copes with shrink-wrapped pallets?\n\n' +
            'We handle roughly 8,000 cartons a day across two sites.\n\nBest regards,\nJames',
        consent_given: true, privacy_version: '2026-01', locale: 'en',
        status: 'answered', assignee: 'Kamil Wilkosz',
        notes: 'Sent datasheet + the Hamburg case study. No reply yet.',
        received_at: ago(31), updated_at: ago(22),
    },
    {
        id: '4',
        first_name: 'Andrea', last_name: 'Köhler',
        company: 'Köhler & Sohn Spedition',
        email: 'info@koehler-spedition.at', phone: '+43 732 7841 0',
        subject: 'Anfrage Systemintegration SAP EWM',
        message:
            'Guten Tag,\n\nwir planen die Anbindung unseres Lagers an SAP EWM und benötigen ' +
            'Unterstützung bei der Schnittstelle. Gibt es Erfahrung mit Anlagen dieser Größe ' +
            '(ca. 4.500 m² Lagerfläche)?\n\nBeste Grüße\nA. Köhler',
        consent_given: true, privacy_version: '2026-01', locale: 'de',
        status: 'new', assignee: null, notes: null,
        received_at: ago(53), updated_at: ago(53),
    },
    {
        id: '5',
        first_name: 'Marco', last_name: 'Rossi',
        company: 'Logistica Rossi S.r.l.',
        email: 'm.rossi@logisticarossi.it', phone: '+39 02 3456 7890',
        subject: 'Squadron Q — informazioni',
        message:
            'Buongiorno,\n\nvorrei ricevere maggiori informazioni su Squadron Q e sulla possibilità ' +
            'di integrarlo con il nostro sistema attuale.\n\nCordiali saluti\nMarco Rossi',
        consent_given: true, privacy_version: '2026-01', locale: 'en',
        status: 'new', assignee: null, notes: null,
        received_at: ago(76), updated_at: ago(76),
    },
    {
        id: '6',
        first_name: 'Dieter', last_name: 'Hoffmann',
        company: 'Hoffmann Maschinenbau',
        email: 'd.hoffmann@hoffmann-mb.de', phone: '+49 511 9032 44',
        subject: 'Wartungsvertrag Bestandsanlage',
        message:
            'Sehr geehrtes Team,\n\nunsere Anlage wurde 2018 von Ihnen errichtet. Wir möchten den ' +
            'Wartungsvertrag erweitern und über eine Fernüberwachung sprechen.\n\n' +
            'Anlagennummer: BSS-2018-0447',
        consent_given: true, privacy_version: '2025-06', locale: 'de',
        status: 'answered', assignee: 'Marek Zuchowski',
        notes: 'Bestandskunde. An Service weitergeleitet.',
        received_at: ago(98), updated_at: ago(90),
    },
    {
        id: '7',
        first_name: 'Crypto', last_name: 'Invest',
        company: 'BTC Growth Partners',
        email: 'noreply@btc-growth-partners.biz', phone: null,
        subject: 'Increase your revenue 300% guaranteed!!!',
        message:
            'Dear Sir/Madam, we offer guaranteed returns on cryptocurrency investment. ' +
            'Click here to claim your bonus now. Limited time offer!!!',
        consent_given: true, privacy_version: '2026-01', locale: 'en',
        status: 'spam', assignee: null, notes: null,
        received_at: ago(120), updated_at: ago(119),
    },
    {
        id: '8',
        first_name: 'Elena', last_name: 'Kowalczyk',
        company: 'Baltic Freight Solutions',
        email: 'e.kowalczyk@balticfreight.pl', phone: '+48 58 301 22 87',
        subject: 'Automatyzacja magazynu — zapytanie ofertowe',
        message:
            'Dzień dobry,\n\nProsimy o ofertę na automatyzację magazynu wysokiego składowania. ' +
            'Powierzchnia 6.000 m², obecnie obsługa ręczna.\n\n' +
            'Czy prowadzą Państwo projekty w Polsce?\n\nZ poważaniem\nElena Kowalczyk',
        consent_given: true, privacy_version: '2026-01', locale: 'en',
        status: 'in_progress', assignee: 'Kamil Wilkosz',
        notes: 'Gdańsk. Przekazane do zespołu sprzedaży.',
        received_at: ago(144), updated_at: ago(130),
    },
];
