# UK Vehicle Dashboard

An interactive data dashboard built with **Next.js (TypeScript)** and **Recharts** to analyse UK vehicle registration trends using the official GOV dataset (VEH0120).

---

## Overview

This dashboard allows dynamic exploration of quarterly UK vehicle registrations by:

- Fuel type (Petrol, Diesel, Electric, etc.)
- Body type
- Manufacturer (Top 20 makes)
- Registration status (Licensed, SORN, Total)
- Custom time ranges

The application includes KPI cards, automated trend insights, market share analysis, EV share calculation, and flexible chart modes (Line / Bar with dual-axis support).

---

## Key Features

- Pre-aggregated data model for fast filtering
- Market share calculation vs total fleet
- EV share detection across electric-related fuels
- 3-year growth analysis
- QoQ (Quarter-over-Quarter) comparison
- Responsive layout
- Clean UI using Tailwind CSS
- Steel-blue visual styling for clarity

---

## Tech Stack

- Next.js 16 (App Router)
- TypeScript
- Recharts
- Tailwind CSS
- PapaParse (CSV parsing)

---

## Dataset

Source: UK Government dataset VEH0120  
Quarterly licensed and SORN vehicle statistics.

Note: The raw CSV file (~60MB) is included for development purposes.

---

## Running Locally

```bash
npm install
npm run dev
