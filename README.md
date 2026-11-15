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
- **Pilot:** registrerar flygnummer och flygbolag (och en valfri destination), väljer flygplats och bana, och begär att få landa eller lyfta. Destinationen kopieras till varje ny förfrågan och syns för ATC och admin. Ändrar du den senare påverkas bara nästa förfrågan. En aktiv förfrågan åt gången.
- **Flyg på väg:** när piloten har valt en av flygplatserna som destination kan hen trycka *Jag är på väg* (med valfri tid kvar i minuter). ATC vid den flygplatsen ser då flyget under *Ankommande flyg*, närmast ankomst först, med ankomsttid, om piloten har skickat en förfrågan och en knapp för att skriva ACARS direkt. Admin ser alla flyg på väg. Flygningen avslutas när piloten trycker *Jag har landat*, när ATC markerar en landning som genomförd, om piloten ändrar destination eller flygnummer, eller automatiskt efter 3 timmar.
- **ATC:** väljer vilken flygplats hen är på och ser då förfrågningarna dit. Godkänner eller nekar med valfritt meddelande, och markerar när banan är fri igen.
- **Banor:** en bana kan bara ha ett godkänt tillstånd åt gången. Upptagna banor visas röda för alla.
- **ACARS:** piloter och ATC skickar korta textmeddelanden (max 200 tecken) till varandra, med snabbtexter att klicka på. Piloten väljer vilken flygplats meddelandet gäller. ATC svarar en pilot som har skrivit eller gjort en förfrågan vid flygplatsen, till exempel med knappen *Svara*. Nya meddelanden visas som en notis. Man kan skicka högst 8 meddelanden per minut.
- **Gruppmeddelanden:** ATC kan skicka ACARS till en enskild pilot, till alla vid flygplatsen eller till alla piloter i hela systemet. Alla vid flygplatsen är piloter som har gjort en förfrågan eller skickat ACARS dit. Meddelande till hela systemet kräver en bekräftelse innan det skickas.
- **Flygplatsstatus:** ATC på plats (och admin för alla flygplatser) kan stänga flygplatsen, stänga enskilda banor och lägga ut information som "Lampor ej tillgängliga" eller "Ground crew ej tillgängligt", med valfri orsak. Piloter kan inte begära tillstånd på en stängd flygplats eller bana, och ATC kan inte godkänna förfrågningar där. Stängningar och information syns på flygplatsens kort för alla. Förfrågningar som redan finns när något stängs ligger kvar, så ATC kan neka dem. Banor som redan har ett pågående tillstånd påverkas inte.
- **Startsida med information:** alla ser *Välkommen* överst, och under den information som admin eller ATC har lagt ut. Admin väljer mottagare i en meny (alla, alla piloter eller alla ATC) och skriver informationen. ATC som är på tjänst väljer mellan piloter vid sin flygplats och alla piloter. Piloter räknas höra till en flygplats om de har en förfrågan där, är på väg dit eller har den som sparad destination. Informationen är högst 300 tecken, visas i 7 dygn och kan tas bort av den som skrev den, och av admin. Nya meddelanden visas även som en notis.
- **Se Aktivitet (admin):** knappen i toppraden öppnar en översikt. *Just nu* visar alla piloter och ATC med om de är online (aktiva de senaste 90 sekunderna) och vad de gör: pilotens förfrågan och flygning på väg, eller ATC:s flygplats. *Senaste händelser* visar inloggningar, förfrågningar och beslut, ACARS, stängningar, information och att gå på eller av tjänst, 48 timmar bakåt och högst 150 rader åt gången. Alternativen i menyn filtrerar på alla, bara piloter eller bara ATC.
- **Gater och terminaler:** ATC på plats (och admin för alla flygplatser) väljer pilot, terminal och en ledig gate under *Gater*, och piloten ser sin gate och terminal på startsidan (med en notis). Knappen *Tilldela gate* finns också vid ankommande flyg och godkända landningar. ATC kan bara ge gate till piloter som har en förfrågan vid flygplatsen, är på väg dit eller har skickat ACARS dit. En pilot har en gate åt gången, så en tidigare gate släpps. Gaten frigörs när ATC trycker *Frigör*, när piloten trycker *Jag har lämnat gaten*, när en start är genomförd, efter 6 timmar eller om kontot spärras eller tas bort. Flygplatskorten visar antal lediga gater.
- **Ljust och mörkt läge:** knappen i toppraden växlar tema. Valet sparas i webbläsaren, och första gången följer sidan enhetens inställning.
- **Väder och tid på dygnet:** ATC och admin väljer en, flera eller alla flygplatser, väljer väder (klart, molnigt, regn, åska, snö, dimma, storm) med valfri kommentar och/eller tid på dygnet (gryning, dag, skymning, natt) och trycker *Rapportera*. Det syns som etiketter på flygplatsernas kort och för piloten när flygplatsen är vald. Man kan ändra bara väder eller bara tid, och ta bort dem igen. ATC kan rapportera för alla flygplatser, inte bara sin egen.
- **Lyckad landning:** när piloten trycker *Jag har landat* (eller *Jag har lyft* på ett godkänt tillstånd) blir förfrågan *Lyckad landning* respektive *Lyckad start* i historiken i stället för *Avbruten*. Banan blir ledig direkt, och en start släpper gaten. *Avbryt landning/start* finns kvar för den som avbryter på riktigt.
- **Nödläge:** piloten trycker *Anmäl nödläge*, väljer flygplats, bana (valfri) och typ (motorproblem, brand, bränslebrist, sjukdom, landningsställ, annat) och skickar. ATC vid flygplatsen och admin får en röd larmruta överst och en notis. ATC väljer bana och trycker *Skicka hjälp till banan*, och piloten ser att hjälp är på väg. Nödläget avslutas av piloten, ATC eller admin, eller efter 3 timmar. Flygplatskortet visar *Nödläge pågår* för alla.
- **Admin:** kan ta bort enskilda förfrågningar, ta bort alla avslutade eller alla förfrågningar, sätta en bana som fri och ta bort ACARS-meddelanden en och en eller alla på en gång. Admin ser hela ACARS-loggen men kan inte skicka meddelanden.
- **Städning:** väntande förfrågningar går ut efter 30 minuter, godkända tillstånd avslutas automatiskt efter 60 minuter och historik rensas efter 2 dygn. ACARS-meddelanden rensas efter 24 timmar. ATC räknas som på plats så länge sidan är öppen.

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

Gater och terminaler finns i samma lista (`terminals`).

Fler flygplatser, banor eller gater läggs till i listan `AIRPORTS` överst i `netlify/functions/api.mjs`.

## Bra att veta

- Systemet kan inte kontrollera att ett Minecraft-namn verkligen tillhör personen som registrerar sig. Det är admins godkännande som är kontrollen.
- Sidan hämtar uppdateringar var 8:e sekund medan fliken är öppen och synlig.
