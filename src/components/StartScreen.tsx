import "./StartScreen.css";

/**
 * Ekran startowy (Etap 0 — placeholder).
 * W Etapie 1 dojdą przyciski wyboru folderu źródłowego i docelowego.
 */
export function StartScreen() {
  return (
    <div className="start-screen">
      <header className="start-screen__brand">
        <h1 className="start-screen__title">fotocull</h1>
        <p className="start-screen__tagline">
          Szybka selekcja zdjęć z karty SD — akceptuj, odrzucaj, kopiuj.
        </p>
      </header>

      <section className="start-screen__placeholder">
        <p>Wybór folderu źródłowego i docelowego pojawi się w Etapie 1.</p>
      </section>
    </div>
  );
}
