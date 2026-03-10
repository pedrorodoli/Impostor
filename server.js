const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mysql = require('mysql2/promise');
const path = require('path');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Configuración de MySQL
const dbConfig = {
  host: 'localhost',
  user: 'root',
  password: '213',
  database: 'impostor'
};

let pool;

// Inicializar base de datos
async function initDB() {
  pool = mysql.createPool(dbConfig);



  await pool.execute(`
    CREATE TABLE IF NOT EXISTS paquetes (
      id VARCHAR(10) PRIMARY KEY,
      nombre VARCHAR(100) NOT NULL,
      es_default BOOLEAN DEFAULT FALSE,
      es_compartido BOOLEAN DEFAULT FALSE,
      creador_uuid VARCHAR(36),
      fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS palabras (
      id INT AUTO_INCREMENT PRIMARY KEY,
      paquete_id VARCHAR(10),
      palabra VARCHAR(100) NOT NULL,
      creador_uuid VARCHAR(36),
      FOREIGN KEY (paquete_id) REFERENCES paquetes(id) ON DELETE CASCADE,
      UNIQUE KEY unique_palabra (paquete_id, palabra)
    )
  `);
  
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS partidas (
      codigo VARCHAR(10) PRIMARY KEY,
      creador_socket VARCHAR(100),
      num_impostores INT DEFAULT 1,
      estado VARCHAR(20) DEFAULT 'esperando',
      paquetes_ids TEXT,
      palabras_usadas TEXT,
      fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS paquetes_guardados (
      usuario_uuid VARCHAR(36) NOT NULL,
      paquete_id VARCHAR(10) NOT NULL,
      PRIMARY KEY (usuario_uuid, paquete_id),
      FOREIGN KEY (paquete_id) REFERENCES paquetes(id) ON DELETE CASCADE
    )
  `);
  
  // Insertar paquete default si no existe
  const [existing] = await pool.execute('SELECT id FROM paquetes WHERE id = "DEFAULT"');
  if (existing.length === 0) {
    await pool.execute(`
      INSERT INTO paquetes (id, nombre, es_default) 
      VALUES ('DEFAULT', 'Paquete por defecto', TRUE)
    `);
    
    const palabrasDefault = [
      'Playa', 'Montaña', 'Ciudad', 'Bosque', 'Desierto',
      'Océano', 'Restaurante', 'Hospital', 'Escuela', 'Cine',
      'Supermercado', 'Parque', 'Biblioteca', 'Museo', 'Gimnasio',
      'Aeropuerto', 'Estación', 'Hotel', 'Cafetería', 'Oficina'
    ];
    
    for (const palabra of palabrasDefault) {
      await pool.execute(
        'INSERT INTO palabras (paquete_id, palabra) VALUES (?, ?)',
        ['DEFAULT', palabra]
      );
    }
  }
}

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Generar código aleatorio
function generarCodigo(length = 5) {
  return Math.random().toString(36).substring(2, 2 + length).toUpperCase();
}

// Helper function to prepare partida object for client emission
function getPartidaForClient(partida) {
  const partidaForClient = { ...partida };
  if (partidaForClient.votos instanceof Map) {
    partidaForClient.votos = Object.fromEntries(partidaForClient.votos);
  }
  // Ensure players array also has UUIDs if needed for client-side logic
  partidaForClient.jugadores = partidaForClient.jugadores.map(j => ({
    id: j.id,
    nombre: j.nombre,
    esImpostor: j.esImpostor,
    expulsado: j.expulsado,
    votado: j.votado,
    uuid: j.uuid, // Include UUID for client-side identification
    esCreador: j.esCreador // Include esCreador for client-side identification
  }));

  // Remove the votingTimer as it causes circular reference issues during serialization
  delete partidaForClient.votingTimer;

  console.log('Datos de la partida para el cliente:', partidaForClient); // LOG PARA DEBUG
  console.log('Partida object after getPartidaForClient:', partidaForClient); // Debug log
  return partidaForClient;
}

// Almacenar partidas activas en memoria
const partidas = new Map();
const jugadoresEnPartida = new Map();
const socketsEnLobby = new Set();
const usuariosConectados = new Map(); // To store { socket.id: nombreUsuario }

// Función para emitir la lista de partidas públicas a los que están en el lobby
function emitirPartidasPublicas() {
  const partidasPublicas = Array.from(partidas.values())
    .filter(p => !p.tienePassword && p.estado === 'esperando')
    .map(p => ({
      codigo: p.codigo,
      nombrePartida: p.nombrePartida,
      jugadores: p.jugadores,
      tienePassword: p.tienePassword
    }));

  socketsEnLobby.forEach(socketId => {
    io.to(socketId).emit('lista-partidas-publicas', partidasPublicas);
  });
}

// Socket.IO
io.on('connection', (socket) => {
  console.log('Usuario conectado:', socket.id);
  socketsEnLobby.add(socket.id);

  socket.on('obtener-partidas-publicas', () => {
    emitirPartidasPublicas();
  });
  
  socket.on('actualizar-nombre-usuario', (data) => {
    const { nombreUsuario } = data;
    if (nombreUsuario) {
      usuariosConectados.set(socket.id, nombreUsuario);
      console.log(`Nombre de usuario actualizado para ${socket.id}: ${nombreUsuario}`);
    }
  });
  
  // Crear partida
  socket.on('crear-partida', async (data) => {
    try {
      const codigo = generarCodigo();
      const { nombreJugador, nombrePartida, password, numImpostores, votingTime, creadorUuid } = data;
      
      const partida = {
        codigo,
        nombrePartida: nombrePartida,
        password: password,
        tienePassword: password ? true : false,
        creador: socket.id, // Keep socket.id for current session creator
        creadorUuid: creadorUuid, // Store UUID for persistent creator identification
        jugadores: [{ id: socket.id, nombre: nombreJugador, esImpostor: false, expulsado: false, votado: false, uuid: creadorUuid }],
        numImpostores: numImpostores || 1,
        votingTime: votingTime || 30, // Tiempo de votación en segundos
        estado: 'esperando',
        paquetes: [],
        palabrasUsadas: [],
        turnoActual: 0,
        ronda: 0,
        votos: new Map()
      };
      
      partidas.set(codigo, partida);
      console.log(`Partida creada: ${codigo}. Creador: ${socket.id}`);
      console.log('Partidas activas:', Array.from(partidas.keys()));
      jugadoresEnPartida.set(socket.id, codigo);
      socketsEnLobby.delete(socket.id);
      socket.join(codigo);
      
      // No se guarda la partida en la BD hasta que empiece, para no acumular partidas vacías
      
      socket.emit('partida-creada', getPartidaForClient(partida)); // Emit full partida object to creator only
      // Defer broadcasting updates until a player (including creator) successfully joins
      // io.to(codigo).emit('actualizar-partida', partida);
      // emitirPartidasPublicas();
    } catch (error) {
      console.error('Error al crear partida:', error);
      socket.emit('error', { mensaje: 'Error al crear partida' });
    }
  });
  
  // Unirse a partida
  socket.on('unirse-partida', async (data) => {
    try {
      const { codigo, nombre, password, usuarioUuid } = data; // Add usuarioUuid to data
      console.log(`Intento de unión a partida: ${codigo} por ${socket.id} (UUID: ${usuarioUuid})`);
      const partida = partidas.get(codigo);
      console.log(`Partida ${codigo} encontrada: ${!!partida}`);
      
      if (!partida) {
        return socket.emit('error', { mensaje: 'Partida no encontrada' });
      }

      // If there's a deletion timer, cancel it
      if (partida.deleteTimeout) {
        clearTimeout(partida.deleteTimeout);
        delete partida.deleteTimeout;
        delete partida.emptySince;
      }

      if (partida.tienePassword && partida.password !== password) {
        return socket.emit('error', { mensaje: 'Contraseña incorrecta' });
      }
      
      if (partida.estado !== 'esperando') {
        return socket.emit('error', { mensaje: 'La partida ya ha comenzado' });
      }
      
      let jugadorExistente = partida.jugadores.find(j => j.id === socket.id || (usuarioUuid && j.uuid === usuarioUuid));
      if (!jugadorExistente) {
        // New player joining
        const esCreadorReconectado = (usuarioUuid && partida.creadorUuid === usuarioUuid);
        partida.jugadores.push({ id: socket.id, nombre, esImpostor: false, expulsado: false, votado: false, uuid: usuarioUuid, esCreador: esCreadorReconectado });
        jugadoresEnPartida.set(socket.id, codigo);
        socketsEnLobby.delete(socket.id);
        socket.join(codigo);
      } else {
        // Existing player reconnecting (update socket.id and potentially creator status)
        jugadorExistente.id = socket.id;
        jugadorExistente.nombre = nombre; // Update name in case it changed
        jugadorExistente.esCreador = (usuarioUuid && partida.creadorUuid === usuarioUuid); // Re-evaluate creator status
        jugadoresEnPartida.set(socket.id, codigo);
        socketsEnLobby.delete(socket.id);
        socket.join(codigo);
      }
      
      socket.emit('unido-partida', { partida: getPartidaForClient(partida) });
      console.log('Partida object before emitting actualizar-partida in unirse-partida:', partida); // Debug log
      io.to(codigo).emit('actualizar-partida', getPartidaForClient(partida));
      emitirPartidasPublicas();
    } catch (error) {
      console.error('Error al unirse a partida:', error);
      socket.emit('error', { mensaje: 'Error al unirse a partida' });
    }
  });
  
  // Empezar partida
  socket.on('empezar-partida', async (data) => {
    try {
      const { codigo, usuarioUuid, paquetes } = data; // Receive paquetes here
      const partida = partidas.get(codigo);
      
      if (!partida || partida.creadorUuid !== usuarioUuid) {
        socket.emit('error', { mensaje: 'No tienes permisos' });
        return;
      }

      // Update partida.paquetes with the received packages
      partida.paquetes = paquetes;
      
      if (partida.jugadores.length < 3) {
        socket.emit('error', { mensaje: 'Se necesitan al menos 3 jugadores' });
        return;
      }
      
      if (partida.paquetes.length === 0) {
        socket.emit('error', { mensaje: 'Selecciona al menos un paquete' });
        return;
      }
      
      // Asignar impostores aleatoriamente
      const jugadoresActivos = partida.jugadores.filter(j => !j.expulsado);
      const impostoresIndices = [];
      while (impostoresIndices.length < partida.numImpostores) {
        const idx = Math.floor(Math.random() * jugadoresActivos.length);
        if (!impostoresIndices.includes(idx)) {
          impostoresIndices.push(idx);
          jugadoresActivos[idx].esImpostor = true;
        }
      }
      
      await seleccionarNuevaPalabra(partida);
      
      // Orden aleatorio de turnos
      partida.ordenTurnos = [...Array(jugadoresActivos.length).keys()]
        .sort(() => Math.random() - 0.5);
      partida.turnoActual = 0;
      partida.ronda = 1;
      partida.estado = 'jugando';
      partida.votos = new Map();
      
      io.to(codigo).emit('partida-iniciada', getPartidaForClient(partida));
      
      // Enviar rol a cada jugador
      jugadoresActivos.forEach(jugador => {
        io.to(jugador.id).emit('tu-rol', {
          esImpostor: jugador.esImpostor,
          palabra: jugador.esImpostor ? null : partida.palabraActual
        });
      });
      
    } catch (error) {
      console.error('Error al empezar partida:', error);
      socket.emit('error', { mensaje: 'Error al empezar partida' });
    }
  });

  async function seleccionarNuevaPalabra(partida) {
    const paquetesIds = partida.paquetes.map(p => `'${p}'`).join(',');
    const [palabras] = await pool.execute(
      `SELECT palabra FROM palabras WHERE paquete_id IN (${paquetesIds})`
    );
    
    let palabrasDisponibles = palabras
      .map(p => p.palabra)
      .filter(p => !partida.palabrasUsadas.includes(p));
    
    if (palabrasDisponibles.length === 0) {
      partida.palabrasUsadas = [];
      palabrasDisponibles = palabras.map(p => p.palabra);
    }
    
    partida.palabraActual = palabrasDisponibles[Math.floor(Math.random() * palabrasDisponibles.length)];
    partida.palabrasUsadas.push(partida.palabraActual);
  }
  
  // Siguiente turno
  socket.on('siguiente-turno', (data) => {
    const { codigo } = data;
    const partida = partidas.get(codigo);
    
    if (!partida) return;
    
    const jugadoresActivos = partida.jugadores.filter(j => !j.expulsado);
    partida.turnoActual++;

    if (partida.turnoActual >= jugadoresActivos.length) {
      iniciarVotacion(codigo);
    } else {
      const jugadorTurno = jugadoresActivos[partida.ordenTurnos[partida.turnoActual]];
      console.log(`Turno de: ${jugadorTurno.nombre}`);
      console.log('Partida object before emitting actualizar-partida in siguiente-turno:', partida); // Debug log
      io.to(codigo).emit('actualizar-partida', getPartidaForClient(partida));
    }
  });

  function iniciarVotacion(codigo) {
    const partida = partidas.get(codigo);
    if (!partida) return;

    partida.estado = 'votacion';
    partida.votos = new Map();
    partida.jugadores.forEach(j => j.votado = false);
    console.log('Partida object before emitting actualizar-partida in iniciarVotacion:', partida); // Debug log
    io.to(codigo).emit('actualizar-partida', getPartidaForClient(partida));

    let tiempoRestante = partida.votingTime;
    partida.votingTimer = setInterval(() => {
      io.to(codigo).emit('actualizar-tiempo', { tiempoRestante });
      tiempoRestante--;
      if (tiempoRestante < 0) {
        procesarVotacion(codigo);
      }
    }, 1000);
  }
  
  // Votar
  socket.on('votar', (data) => {
    const { codigo, votadoId } = data;
    const partida = partidas.get(codigo);
    
    if (!partida || partida.estado !== 'votacion') return;
    
    const voterSocketId = socket.id;

    if (partida.votos.get(voterSocketId) === votadoId) {
      // Player is un-voting the same player
      partida.votos.delete(voterSocketId);
    } else {
      // Player is voting or changing their vote
      partida.votos.set(voterSocketId, votadoId);
    }
    
    // Emit vote updates to all clients
    emitirActualizacionVotos(codigo);
  });

  function emitirActualizacionVotos(codigo) {
    const partida = partidas.get(codigo);
    if (!partida) return;

    const conteoVotos = {};
    partida.votos.forEach(votadoId => {
      conteoVotos[votadoId] = (conteoVotos[votadoId] || 0) + 1;
    });
    io.to(codigo).emit('actualizar-votos', { conteoVotos });
  }
  
  function procesarVotacion(codigo) {
    const partida = partidas.get(codigo);
    if (!partida) return;

    clearInterval(partida.votingTimer);
    
    const conteoVotos = {};
    partida.votos.forEach(votadoId => {
      conteoVotos[votadoId] = (conteoVotos[votadoId] || 0) + 1;
    });
    
    let maxVotos = 0;
    let candidatosExpulsion = [];
    Object.entries(conteoVotos).forEach(([id, votos]) => {
      if (votos > maxVotos) {
        maxVotos = votos;
        candidatosExpulsion = [id]; // New max, reset candidates
      } else if (votos === maxVotos) {
        candidatosExpulsion.push(id); // Add to candidates if tied
      }
    });
    
    if (candidatosExpulsion.length === 1) { // Only expel if there's a clear winner
      const expulsadoId = candidatosExpulsion[0];
      const expulsado = partida.jugadores.find(j => j.id === expulsadoId);
      if (expulsado) {
        expulsado.expulsado = true;
        
        io.to(codigo).emit('jugador-expulsado', {
          jugador: expulsado,
          votos: conteoVotos
        });
        
        // Verificar condiciones de victoria
        setTimeout(() => verificarVictoria(codigo), 3000);
      }
    } else { // Tie or no votes, no one is expelled
      io.to(codigo).emit('jugador-expulsado', {
        jugador: null, // Indicate no one was expelled
        mensaje: 'Empate en la votación, nadie es expulsado.',
        votos: conteoVotos
      });
      // If no one is expelled, continue the game after a delay
      setTimeout(() => {
        partida.turnoActual = 0;
        partida.ronda++;
        partida.estado = 'jugando';
        partida.votos = new Map();
        partida.jugadores.forEach(j => j.votado = false);
        io.to(codigo).emit('actualizar-partida', getPartidaForClient(partida));
      }, 3000);
    }
  }
  
  function verificarVictoria(codigo) {
    const partida = partidas.get(codigo);
    if (!partida) return;
    
    const jugadoresActivos = partida.jugadores.filter(j => !j.expulsado);
    const impostoresActivos = jugadoresActivos.filter(j => j.esImpostor);
    const inocentesActivos = jugadoresActivos.filter(j => !j.esImpostor);
    
    if (impostoresActivos.length === 0) {
      partida.estado = 'finalizada';
      partida.ganador = 'inocentes';
      io.to(codigo).emit('partida-finalizada', { ganador: 'inocentes', partida: getPartidaForClient(partida) });
    } else if (impostoresActivos.length >= inocentesActivos.length) {
      partida.estado = 'finalizada';
      partida.ganador = 'impostores';
      io.to(codigo).emit('partida-finalizada', { ganador: 'impostores', partida: getPartidaForClient(partida) });
    } else {
      // Continuar jugando: empezar nueva ronda
      partida.turnoActual = 0;
      partida.ronda++;
      partida.estado = 'jugando';
      partida.votos = new Map();
      partida.jugadores.forEach(j => j.votado = false);
      console.log('Partida object before emitting actualizar-partida in verificarVictoria (continue playing):', partida); // Debug log
      io.to(codigo).emit('actualizar-partida', getPartidaForClient(partida));
    }
  }
  
  // Volver a jugar
  socket.on('volver-jugar', async (data) => {
    const { codigo, usuarioUuid } = data;
    const partida = partidas.get(codigo);
    
    if (!partida || partida.creadorUuid !== usuarioUuid) return;

    // Resetear estado de la partida para una nueva ronda
    partida.jugadores.forEach(j => {
      j.esImpostor = false;
      j.expulsado = false;
      j.votado = false;
    });
    
    // Re-asignar impostores
    const jugadoresActivos = partida.jugadores;
    const impostoresIndices = [];
    while (impostoresIndices.length < partida.numImpostores) {
      const idx = Math.floor(Math.random() * jugadoresActivos.length);
      if (!impostoresIndices.includes(idx)) {
        impostoresIndices.push(idx);
        jugadoresActivos[idx].esImpostor = true;
      }
    }

    await seleccionarNuevaPalabra(partida);

    partida.estado = 'jugando';
    partida.turnoActual = 0;
    partida.ronda = 1;
    partida.votos = new Map();
    partida.ordenTurnos = [...Array(jugadoresActivos.length).keys()].sort(() => Math.random() - 0.5);

    io.to(codigo).emit('partida-iniciada', getPartidaForClient(partida));

    // Enviar nuevos roles
    jugadoresActivos.forEach(jugador => {
      io.to(jugador.id).emit('tu-rol', {
        esImpostor: jugador.esImpostor,
        palabra: jugador.esImpostor ? null : partida.palabraActual
      });
    });
  });

  // --- LÓGICA DE PAQUETES ---
  socket.on('crear-paquete', async (data) => {
    try {
      const { nombre, esCompartido, creadorUuid } = data;
      const id = generarCodigo(8);
      
      // Convert undefined to null for SQL parameters
      const shared = esCompartido === undefined ? null : esCompartido;
      const creator = creadorUuid === undefined ? null : creadorUuid;

      await pool.execute(
        'INSERT INTO paquetes (id, nombre, es_compartido, creador_uuid) VALUES (?, ?, ?, ?)',
        [id, nombre, shared, creator]
      );
      
      socket.emit('paquete-creado', { id: id });
    } catch (error) {
      console.error('Error al crear paquete:', error);
      socket.emit('error', { mensaje: 'Error al crear paquete' });
    }
  });

    socket.on('obtener-mis-paquetes', async (data) => {

      try {

        let usuarioUuid = data ? data.usuarioUuid : undefined;

  

        // If usuarioUuid is not provided in the event data, try to get it from stored connected users

        if (!usuarioUuid) {

          // Assuming that if nombreUsuario was stored, we can use it to find a corresponding UUID if needed.

          // However, the request is to use UUID directly, so we should expect it.

          // For now, if usuarioUuid is not provided, we will treat it as an error.

          // The previous logic for nombreUsuario was to get it from `usuariosConectados` map.

          // If we want to map socket.id to uuid, we need a new map or modify `usuariosConectados`.

          // For simplicity, let's assume client always sends usuarioUuid or it's an error.

        }

  

              if (!usuarioUuid) { // If still no usuarioUuid, then it's truly missing

  

                return socket.emit('error', { mensaje: 'usuarioUuid es requerido para obtener los paquetes.' });

  

              }

  

        const [paquetes] = await pool.execute(

          `SELECT p.*, COUNT(pal.id) as num_palabras FROM paquetes p 

           LEFT JOIN palabras pal ON p.id = pal.paquete_id 

           WHERE p.creador_uuid = ? OR p.es_default = TRUE OR p.id IN (SELECT paquete_id FROM paquetes_guardados WHERE usuario_uuid = ?)

           GROUP BY p.id`,

          [usuarioUuid, usuarioUuid]

        );
      socket.emit('lista-mis-paquetes', paquetes);
    } catch (error) {
      console.error('Error al obtener mis paquetes:', error);
    }
  });

  socket.on('obtener-detalle-paquete', async (data) => {
    try {
      const { paqueteId, creadorUuid } = data;
      const [[paquete]] = await pool.execute(
        `SELECT p.*, COUNT(pal.id) as num_palabras FROM paquetes p 
         LEFT JOIN palabras pal ON p.id = pal.paquete_id 
         WHERE p.id = ? 
         GROUP BY p.id`,
        [paqueteId]
      );

      if (!paquete) return socket.emit('error', { mensaje: 'Paquete no encontrado' });

      let palabras;
      if (paquete.es_compartido) {
        // If the package is shared, anyone can see all words in it
        [palabras] = await pool.execute(
          'SELECT id, palabra, creador_uuid FROM palabras WHERE paquete_id = ?',
          [paqueteId]
        );
      } else {
        // If the package is not shared, only the package creator can see the words
        // And only words created by that specific creator
        [palabras] = await pool.execute(
          'SELECT id, palabra, creador_uuid FROM palabras WHERE paquete_id = ? AND creador_uuid = ?',
          [paqueteId, paquete.creador_uuid]
        );
      }

      socket.emit('detalle-paquete', { paquete, palabras });
    } catch (error) {
      console.error('Error al obtener detalle de paquete:', error);
      socket.emit('error', { mensaje: 'Error al obtener detalle de paquete' });
    }
  });

  socket.on('anadir-palabra', async (data) => {
    try {
      const { paqueteId, palabra, creadorUuid } = data;
      const [[paquete]] = await pool.execute('SELECT * FROM paquetes WHERE id = ?', [paqueteId]);

      if (!paquete) return socket.emit('error', { mensaje: 'Paquete no encontrado' });

      // Solo el creador puede añadir si no es compartido
      // Now checking against creador_uuid
      if (!paquete.es_compartido && paquete.creador_uuid !== creadorUuid) {
        return socket.emit('error', { mensaje: 'No tienes permiso para añadir palabras a este paquete.' });
      }

      const [result] = await pool.execute(
        'INSERT INTO palabras (paquete_id, palabra, creador_uuid) VALUES (?, ?, ?)',
        [paqueteId, palabra, creadorUuid]
      );

      const nuevaPalabra = { id: result.insertId, paquete_id: paqueteId, palabra };
      socket.emit('palabra-anadida', nuevaPalabra);

      // Notificar a todos los que estén viendo el paquete del nuevo total
      const [total] = await pool.execute('SELECT COUNT(*) as total FROM palabras WHERE paquete_id = ?', [paqueteId]);
      io.emit('paquete-actualizado', { paqueteId, totalPalabras: total[0].total });

    } catch (error) {
      console.error('Error al añadir palabra:', error);
      socket.emit('error', { mensaje: 'La palabra ya existe en este paquete.' });
    }
  });

  socket.on('eliminar-palabra', async (data) => {
    try {
      const { palabraId, creadorUuid } = data;
      // Asegurarse que solo el que la creó la puede borrar
      const [result] = await pool.execute(
        'DELETE FROM palabras WHERE id = ? AND creador_uuid = ?',
        [palabraId, creadorUuid]
      );

      if (result.affectedRows > 0) {
        socket.emit('palabra-eliminada', { palabraId });
      } else {
        socket.emit('error', { mensaje: 'No puedes borrar esta palabra.' });
      }
    } catch (error) {
      console.error('Error al eliminar palabra:', error);
    }
  });

  socket.on('eliminar-paquete', async (data) => {
    try {
      const { paqueteId, creadorUuid } = data;
      // Asegurarse que solo el creador puede borrar el paquete
      const [result] = await pool.execute(
        'DELETE FROM paquetes WHERE id = ? AND creador_uuid = ?',
        [paqueteId, creadorUuid]
      );

      if (result.affectedRows > 0) {
        socket.emit('paquete-eliminado');
      } else {
        socket.emit('error', { mensaje: 'No puedes borrar este paquete.' });
      }
    } catch (error) {
      console.error('Error al eliminar paquete:', error);
    }
  });

  socket.on('actualizar-estado-compartir-paquete', async (data) => {
    try {
      const { paqueteId, esCompartido, creadorUuid } = data;
      const [[paquete]] = await pool.execute('SELECT creador_uuid FROM paquetes WHERE id = ?', [paqueteId]);

      if (!paquete || paquete.creador_uuid !== creadorUuid) {
        return socket.emit('error', { mensaje: 'No tienes permiso para cambiar el estado de este paquete.' });
      }

      await pool.execute(
        'UPDATE paquetes SET es_compartido = ? WHERE id = ?',
        [esCompartido, paqueteId]
      );
      io.emit('paquete-estado-compartir-actualizado', { paqueteId, esCompartido });
    } catch (error) {
      console.error('Error al actualizar estado de compartir paquete:', error);
      socket.emit('error', { mensaje: 'Error al actualizar estado de compartir paquete.' });
    }
  });

  socket.on('guardar-paquete', async (data) => {
    try {
      const { paqueteId, usuarioUuid } = data;
      await pool.execute(
        'INSERT INTO paquetes_guardados (usuario_uuid, paquete_id) VALUES (?, ?)',
        [usuarioUuid, paqueteId]
      );
      socket.emit('paquete-guardado');
    } catch (error) {
      console.error('Error al guardar paquete:', error);
      socket.emit('error', { mensaje: 'Error al guardar paquete' });
    }
  });
  
  // Obtener paquetes para la configuración de la partida
  socket.on('obtener-paquetes', async (data) => {
    try {
      const { usuarioUuid } = data;
      const [paquetes] = await pool.execute(
        `SELECT p.*, COUNT(pal.id) as num_palabras FROM paquetes p 
         LEFT JOIN palabras pal ON p.id = pal.paquete_id 
         WHERE p.creador_uuid = ? OR p.es_default = TRUE OR p.id IN (SELECT paquete_id FROM paquetes_guardados WHERE usuario_uuid = ?)
         GROUP BY p.id`,
        [usuarioUuid, usuarioUuid]
      );
      socket.emit('lista-paquetes', paquetes);
    } catch (error) {
      console.error('Error al obtener paquetes para configuración:', error);
    }
  });

  socket.on('obtener-votos', (data) => {
    const { codigo } = data;
    emitirActualizacionVotos(codigo);
  });

  // Generar QR
  socket.on('generar-qr', async (data) => {
    try {
      const { url } = data;
      const qrCode = await QRCode.toDataURL(url);
      socket.emit('qr-generado', { qrCode });
    } catch (error) {
      console.error('Error al generar QR:', error);
    }
  });
  
  // Desconexión
  socket.on('disconnect', () => {
    console.log('Usuario desconectado:', socket.id);
    socketsEnLobby.delete(socket.id);
    usuariosConectados.delete(socket.id); // Clean up stored username
    
    const codigoPartida = jugadoresEnPartida.get(socket.id);
    if (codigoPartida) {
      const partida = partidas.get(codigoPartida);
      if (partida) {
        partida.jugadores = partida.jugadores.filter(j => j.id !== socket.id);
        
        if (partida.jugadores.length === 0) {
          partida.emptySince = Date.now(); // Mark the time it became empty
          partida.deleteTimeout = setTimeout(() => {
            partidas.delete(codigoPartida);
            emitirPartidasPublicas();
            console.log(`Partida ${codigoPartida} eliminada por inactividad.`);
          }, 2 * 60 * 1000); // 2 minutes
        } else {
          if (partida.creador === socket.id && partida.jugadores.length > 0) {
            partida.creador = partida.jugadores[0].id;
          }
          console.log('Partida object before emitting actualizar-partida in disconnect:', partida); // Debug log
          io.to(codigoPartida).emit('actualizar-partida', getPartidaForClient(partida));
        }
      }
      jugadoresEnPartida.delete(socket.id);
    }
  });
});



// Rutas API



initDB().then(() => {

    const PORT = process.env.PORT || 3008;

    server.listen(PORT, () => {

        console.log(`Servidor escuchando en el puerto ${PORT}`);

    });

}).catch(err => {

    console.error('Error al inicializar la base de datos:', err);

    process.exit(1);

});
