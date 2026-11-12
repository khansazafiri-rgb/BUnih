import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './theme.css';
import './app.css';

const akar = document.getElementById('akar');
if (!akar) throw new Error('Elemen #akar tidak ditemukan.');

createRoot(akar).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
