/**
 * Model danych: "zdjęcie" = para plików JPG + (opcjonalnie) ARW o wspólnej
 * nazwie bazowej. Wypełniane w Etapie 2 (skan nośnika).
 */
export interface Photo {
  /** Nazwa bazowa bez rozszerzenia, np. "DSC01234". */
  baseName: string;
  /** Ścieżka do pliku JPG (jeśli istnieje). */
  jpgPath?: string;
  /** Ścieżka do pliku ARW (jeśli istnieje). */
  arwPath?: string;
  /** Katalog źródłowy, w którym leży para. */
  sourceDir: string;
  /** SHA-256 pliku JPG — liczony w Etapie 3, używany do dedupu i manifestu. */
  jpgHash?: string;
}
