const API_BASE = '/api';
const ASSETS_BASE = 'https://warframe.market/static/assets';

// DOM Elements
const grid = document.getElementById('weapons-grid');
const searchInput = document.getElementById('search-input');
const hideOwnedCheckbox = document.getElementById('hide-owned-checkbox');
const sortSelect = document.getElementById('sort-select');
const crossplayCheckbox = document.getElementById('crossplay-checkbox');
const filterWeaponsCheckbox = document.getElementById('filter-weapons-checkbox');
const filterWarframesCheckbox = document.getElementById('filter-warframes-checkbox');
const progressContainer = document.getElementById('progress-container');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const btnRefresh = document.getElementById('btn-refresh-prices');

// State
let weapons = [];
let ownedWeapons = JSON.parse(localStorage.getItem('ownedWeapons')) || [];
let priceCache = JSON.parse(localStorage.getItem('priceCache')) || {};
let isFetchingPrices = false;
const CACHE_EXPIRY = 2 * 60 * 60 * 1000; // 2 hours in ms

const rateLimiter = {
    queue: [],
    isProcessing: false,
    add(fn) {
        return new Promise((resolve, reject) => {
            this.queue.push({ fn, resolve, reject });
            this.process();
        });
    },
    async process() {
        if (this.isProcessing) return;
        this.isProcessing = true;
        while (this.queue.length > 0) {
            const task = this.queue.shift();
            // Start the fetch without awaiting its response, so network latency doesn't block the next request
            task.fn().then(task.resolve).catch(task.reject);
            // Strictly wait 335ms between starting requests (max ~3 per second)
            await new Promise(r => setTimeout(r, 335));
        }
        this.isProcessing = false;
    }
};

const PLAT_ICON = `<svg class="plat-icon" viewBox="0 0 512 512" width="20" height="20" xmlns="http://www.w3.org/2000/svg"><path d="M256 0C114.6 0 0 114.6 0 256s114.6 256 256 256 256-114.6 256-256S397.4 0 256 0zm0 464c-114.7 0-208-93.3-208-208S141.3 48 256 48s208 93.3 208 208-93.3 208-208 208zm112-208c0 61.8-50.2 112-112 112s-112-50.2-112-112 50.2-112 112-112 112 50.2 112 112z" fill="var(--accent-primary)"/></svg>`;

// Keywords for tradeable weapons
const WEAPON_KEYWORDS = ['prime_set', 'vandal', 'wraith', 'prisma', 'vaykor', 'telos', 'synoid', 'secura', 'rakta', 'sancti', 'carmine'];

function isWeapon(item) {
    const urlName = item.url_name.toLowerCase();
    // Exclude skins, relics, etc.
    if (urlName.includes('skin') || urlName.includes('relic') || urlName.includes('noggle')) return false;
    
    return WEAPON_KEYWORDS.some(kw => urlName.endsWith(`_${kw}`) || urlName === kw || urlName.includes(kw));
}

async function init() {
    try {
        const res = await fetch(`${API_BASE}/items`);
        const data = await res.json();
        
        // Filter and map weapons
        weapons = data.data
            .filter(item => {
                if (!item.i18n || !item.i18n.en || !item.i18n.en.name || !item.tags) return false;
                const name = item.i18n.en.name.toLowerCase();
                const isTarget = name.includes('prime set') || name.includes('vandal') || name.includes('wraith') || name.includes('kuva') || name.includes('tenet');
                
                const isWeapon = item.tags.includes('weapon');
                const isWarframe = item.tags.includes('warframe');
                const isComponent = item.tags.includes('component') || item.tags.includes('blueprint');
                
                return isTarget && (isWeapon || isWarframe) && !isComponent;
            })
            .map(item => ({
                id: item.slug,
                name: item.i18n.en.name,
                url_name: item.slug,
                thumb: ASSETS_BASE + '/' + item.i18n.en.thumb,
                price: getCachedPrice(item.slug),
                category: item.tags.includes('warframe') ? 'warframe' : 'weapon',
                type: getWeaponType(item.i18n.en.name)
            }))
            .sort((a, b) => a.name.localeCompare(b.name));

        render();
        // Do NOT auto-fetch prices on load as per user request
        
    } catch (error) {
        console.error('Error fetching items:', error);
        grid.innerHTML = `<div class="no-results">Error al cargar la base de datos de armas. Por favor, intenta de nuevo más tarde.</div>`;
    }
}

function getWeaponType(name) {
    if (name.includes('Prime')) return 'Prime';
    if (name.includes('Vandal')) return 'Vandal';
    if (name.includes('Wraith')) return 'Wraith';
    if (name.includes('Prisma')) return 'Prisma';
    if (name.includes('Vaykor') || name.includes('Telos') || name.includes('Synoid') || name.includes('Secura') || name.includes('Rakta') || name.includes('Sancti')) return 'Syndicate';
    return 'Special';
}

function getCachedPrice(urlName) {
    const cached = priceCache[urlName];
    if (cached && (Date.now() - cached.timestamp < CACHE_EXPIRY)) {
        return cached.price;
    }
    return null;
}

async function startPriceFetchQueue(force = false) {
    if (isFetchingPrices) return;
    isFetchingPrices = true;
    
    // Find items that need price fetch (ONLY the ones currently matching the filters)
    const displayWeapons = filterAndSortWeapons();
    const weaponsToFetch = force 
        ? displayWeapons 
        : displayWeapons.filter(w => w.price === null);
        
    if (weaponsToFetch.length === 0) {
        progressContainer.style.display = 'none';
        isFetchingPrices = false;
        return;
    }

    progressContainer.style.display = 'flex';
    let completed = 0;
    const total = weaponsToFetch.length;
    
    updateProgress(0, total);

    weaponsToFetch.forEach(weapon => {
        (async () => {
            try {
                const cacheKey = weapon.id + (crossplayCheckbox.checked ? '_global' : '_pc');
                
                if (!force && priceCache[cacheKey] && Date.now() - priceCache[cacheKey].timestamp < CACHE_DURATION) {
                    weapon.price = priceCache[cacheKey].price;
                    completed++;
                    updateProgress(completed, total);
                    if (sortSelect.value.startsWith('price')) render();
                    else updateWeaponCardPrice(weapon.url_name, weapon.price);
                    
                    if (completed === total) finishFetching();
                    return;
                }
                
                let platformsToFetch = ['pc'];
                if (crossplayCheckbox.checked) {
                    platformsToFetch = ['pc', 'ps4', 'xbox', 'switch']; 
                }
                
                const fetchPromises = platformsToFetch.map(plat => {
                    return rateLimiter.add(async () => {
                        const res = await fetch(`${API_BASE}/orders/item/${weapon.id}`, {
                            headers: { 'x-platform': plat }
                        });
                        const data = await res.json();
                        if (!data || !data.data) return [];
                        
                        return data.data.filter(order => {
                            if (order.type !== 'sell') return false;
                            if (order.user.status !== 'ingame') return false;
                            if (crossplayCheckbox.checked && plat !== 'pc' && !order.user.crossplay) return false;
                            return true;
                        });
                    });
                });
                
                const results = await Promise.all(fetchPromises);
                const allSellOrders = results.flat();
                
                if (allSellOrders.length > 0) {
                    const lowestPrice = Math.min(...allSellOrders.map(o => o.platinum));
                    weapon.price = lowestPrice;
                    priceCache[cacheKey] = { price: lowestPrice, timestamp: Date.now() };
                } else {
                    weapon.price = -1;
                    priceCache[cacheKey] = { price: -1, timestamp: Date.now() };
                }
                
                localStorage.setItem('priceCache', JSON.stringify(priceCache));
                
                if (sortSelect.value.startsWith('price')) render();
                else updateWeaponCardPrice(weapon.url_name, weapon.price);
                
            } catch (error) {
                console.error(`Failed to fetch price for ${weapon.url_name}`, error);
            }
            
            completed++;
            updateProgress(completed, total);
            
            if (completed === total) finishFetching();
            
        })();
    });
}

function finishFetching() {
    isFetchingPrices = false;
    setTimeout(() => {
        progressContainer.style.display = 'none';
    }, 2000);
}

function updateProgress(completed, total) {
    const percent = Math.round((completed / total) * 100);
    progressBar.style.width = `${percent}%`;
    progressText.textContent = `Cargando precios... ${completed}/${total} (${percent}%)`;
}

function updateWeaponCardPrice(urlName, price) {
    const priceEl = document.getElementById(`price-${urlName}`);
    if (priceEl) {
        if (price === null) {
            priceEl.innerHTML = `<span class="price-loading">Cargando...</span>`;
        } else if (price === -1) {
            priceEl.innerHTML = `<span class="price-loading">Sin vendedores</span>`;
        } else {
            priceEl.innerHTML = `${PLAT_ICON} <span class="price-value">${price}</span>`;
        }
    }
}

function toggleOwn(urlName, event) {
    event.stopPropagation();
    
    if (ownedWeapons.includes(urlName)) {
        ownedWeapons = ownedWeapons.filter(id => id !== urlName);
        localStorage.setItem('ownedWeapons', JSON.stringify(ownedWeapons));
        render();
    } else {
        ownedWeapons.push(urlName);
        localStorage.setItem('ownedWeapons', JSON.stringify(ownedWeapons));
        
        // Update the button visually immediately
        const btn = event.currentTarget;
        if (btn) {
            btn.innerHTML = '✔ Obtenido';
            btn.closest('.weapon-card').classList.add('owned');
        }
        
        // If "Hide Owned" is active, wait 2 seconds before removing it from the grid
        if (hideOwnedCheckbox.checked) {
            if (btn) btn.closest('.weapon-card').style.opacity = '0.5';
            setTimeout(() => {
                render();
            }, 2000);
        } else {
            render();
        }
    }
}

// Global scope binding for inline onclick
window.toggleOwn = toggleOwn;

function filterAndSortWeapons() {
    const query = searchInput.value.toLowerCase();
    const hideOwned = hideOwnedCheckbox.checked;
    const showWeapons = filterWeaponsCheckbox.checked;
    const showWarframes = filterWarframesCheckbox.checked;
    const sortBy = sortSelect.value;
    
    let filtered = weapons.filter(w => {
        const matchName = w.name.toLowerCase().includes(query);
        const matchOwned = hideOwned ? !ownedWeapons.includes(w.url_name) : true;
        const matchCategory = (w.category === 'weapon' && showWeapons) || (w.category === 'warframe' && showWarframes);
        return matchName && matchOwned && matchCategory;
    });
    
    filtered.sort((a, b) => {
        if (sortBy === 'name-asc') return a.name.localeCompare(b.name);
        
        // Handle null/-1 prices (push them to the bottom)
        const priceA = a.price && a.price > 0 ? a.price : Infinity;
        const priceB = b.price && b.price > 0 ? b.price : Infinity;
        
        if (sortBy === 'price-asc') return priceA - priceB;
        if (sortBy === 'price-desc') {
            if (priceA === Infinity) return 1;
            if (priceB === Infinity) return -1;
            return priceB - priceA;
        }
        return 0;
    });
    
    return filtered;
}

function render() {
    const displayWeapons = filterAndSortWeapons();
    
    if (displayWeapons.length === 0) {
        grid.innerHTML = `<div class="no-results">No se encontraron armas que coincidan con los filtros.</div>`;
        return;
    }
    
    grid.innerHTML = displayWeapons.map(w => {
        const isOwned = ownedWeapons.includes(w.url_name);
        let priceHtml = `<span class="price-loading">Cargando...</span>`;
        
        if (w.price === -1) {
            priceHtml = `<span class="price-loading">Sin vendedores</span>`;
        } else if (w.price > 0) {
            priceHtml = `${PLAT_ICON} <span class="price-value">${w.price}</span>`;
        }
        
        return `
            <div class="weapon-card glass-panel ${isOwned ? 'owned' : ''}">
                <div class="card-header">
                    <img src="${w.thumb}" alt="${w.name}" class="item-thumb" loading="lazy">
                    <div class="item-info">
                        <h3 class="item-name">${w.name}</h3>
                        <span class="item-type">${w.type}</span>
                    </div>
                </div>
                
                <div class="card-price" id="price-${w.url_name}">
                    ${priceHtml}
                </div>
                
                <div class="card-actions">
                    <button class="btn btn-toggle-own" onclick="toggleOwn('${w.url_name}', event)">
                        ${isOwned ? '✔ Obtenido' : 'Marcar como Obtenido'}
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

// Event Listeners
searchInput.addEventListener('input', render);
hideOwnedCheckbox.addEventListener('change', render);
sortSelect.addEventListener('change', render);

function resetAndFetch() {
    priceCache = {};
    localStorage.removeItem('priceCache');
    weapons.forEach(w => w.price = null);
    render();
    startPriceFetchQueue(true);
}

// Re-render when checkboxes change without fetching
filterWeaponsCheckbox.addEventListener('change', render);
filterWarframesCheckbox.addEventListener('change', render);
crossplayCheckbox.addEventListener('change', render);

btnRefresh.addEventListener('click', resetAndFetch);

// Boot
init();
