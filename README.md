# EDU Flygledning

Flygledningssystem för Minecraft-servern EDU. Piloter begär tillstånd att landa och lyfta, ATC svarar, och admin godkänner alla nya konton.

## Innehåll

```
public/index.html              Hela webbsidan (inloggning, pilot-, ATC- och adminvy)
netlify/functions/api.mjs      Backend: konton, sessioner, förfrågningar
netlify.toml                   Netlify-inställningar
package.json                   Beroende: @netlify/blobs (databasen)
```

## Lägga upp på Netlify

Webbsidan behöver en backend så att alla spelare ser samma konton och förfrågningar. Därför räcker det inte att bara släppa `index.html` på Netlify. Använd någon av dessa vägar, så installerar Netlify beroendena åt dig:

**A. Via GitHub (enklast att uppdatera)**
1. Lägg mappen i ett nytt GitHub-repo (utan `node_modules`).
2. På Netlify: *Add new site → Import an existing project* och välj repot.
3. Låt inställningarna stå kvar (de läses från `netlify.toml`) och tryck *Deploy*.

**B. Via Netlify CLI**
```
npm install
npx netlify-cli login
npx netlify-cli deploy --prod
```
Första gången får du välja eller skapa en site.

Databasen (Netlify Blobs) behöver ingen uppsättning. Den fungerar automatiskt när sidan körs på Netlify.

## Adminkonto

Användarnamn `Byggnadsnamden`, lösenord `Nämden2026!`.

Lösenordet ligger som standardvärde i `api.mjs`. Vill du inte ha det i koden, sätt miljövariablerna `ADMIN_USERNAME` och `ADMIN_PASSWORD` under *Site configuration → Environment variables* på Netlify. De går före standardvärdet.

## Så fungerar det

- **Konton:** inloggning med Minecraft-användarnamn och lösenord. Nya konton (pilot eller ATC) väntar på godkännande av admin. Admin kan också neka, spärra, byta lösenord och ta bort konton.
- **Pilot:** registrerar flygnummer och flygbolag, väljer flygplats och bana, och begär att få landa eller lyfta. En aktiv förfrågan åt gången.
- **ATC:** väljer vilken flygplats hen är på och ser då förfrågningarna dit. Godkänner eller nekar med valfritt meddelande, och markerar när banan är fri igen.
- **Banor:** en bana kan bara ha ett godkänt tillstånd åt gången. Upptagna banor visas röda för alla.
- **Städning:** väntande förfrågningar går ut efter 30 minuter, godkända tillstånd avslutas automatiskt efter 60 minuter och historik rensas efter 2 dygn. ATC räknas som på plats så länge sidan är öppen.

## Flygplatser och banor

| Flygplats | Banor |
|---|---|
| Katrineholm Kattport International Airport | 1A, 2A, 3A, 4A, 1B, 2B, 3B, 4B |
| Malmö International Airport | 1 |
| UK International Airport | 1 |
| Hallonbergen Airport | 1 |
| Katrineholm Halvön Airport | 1 |
| Turkmenistan Internationella Flygfält | 1 |
| Borgvik Airport | 1 |

Fler flygplatser eller banor läggs till i listan `AIRPORTS` överst i `netlify/functions/api.mjs`.

## Bra att veta

- Systemet kan inte kontrollera att ett Minecraft-namn verkligen tillhör personen som registrerar sig. Det är admins godkännande som är kontrollen.
- Sidan hämtar uppdateringar var 8:e sekund medan fliken är öppen och synlig.
