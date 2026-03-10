        // UUID Management
        let currentUserUuid;

        function getOrCreateUserUuid() {
            let userUuid = localStorage.getItem('userUuid');
            let isNewUuid = false;

            if (!userUuid) {
                // Generate a new UUID
                userUuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
                    var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
                    return v.toString(16);
                });
                localStorage.setItem('userUuid', userUuid);
                isNewUuid = true;
            }

            console.log(`UUID del usuario: ${userUuid}`);
            console.log(`¿Es un UUID nuevo?: ${isNewUuid ? 'Sí' : 'No'}`);

            return userUuid;
        }

        document.addEventListener('DOMContentLoaded', () => {
            currentUserUuid = getOrCreateUserUuid();
        });

        const socket = io();
        let miId = null;
        let partidaActual = null;
        let miNombre = localStorage.getItem('nombreJugador') || ''; // Initialize from localStorage
        let esCreador = false;
        let miRol = null;
        let partidaAUnirse = null; // Para guardar el código de la partida a la que se intenta unir
        let paqueteActual = null;
        let nombreGuardado = localStorage.getItem('nombreJugador');

        // Listeners de Socket.IO
        socket.on('connect', () => {
            miId = socket.id;
            
            // If on partida.html and a game code is available from the URL, try to join
            if (window.location.pathname === '/partida.html' && typeof gameCodeFromUrl !== 'undefined' && gameCodeFromUrl) {
                if (!miNombre) {
                    // If no name, show the name input modal
                    document.getElementById('modal-ingresar-nombre').classList.remove('hidden');
                } else {
                    // If name exists, proceed to join
                    socket.emit('unirse-partida', { codigo: gameCodeFromUrl, nombre: miNombre, usuarioUuid: currentUserUuid });
                }
            }
        });

        socket.on('partida-creada', (partida) => { // Expect full partida object directly
            partidaActual = partida;
            esCreador = true;
            if (window.location.pathname !== '/partida.html') {
                window.location.href = `/partida.html?codigo=${partida.codigo}`;
            }
        });

        socket.on('unido-partida', (data) => {
            partidaActual = data.partida;
            esCreador = partidaActual.creador === miId;
            if (window.location.pathname !== '/partida.html') {
                window.location.href = `/partida.html?codigo=${partidaActual.codigo}`;
            }
        });

        socket.on('lista-partidas-publicas', (partidas) => {
            // This will be handled in lobby.html
        });

        socket.on('actualizar-partida', (partida) => {
            partidaActual = partida;
            // This will be handled in partida.html
        });

        socket.on('partida-iniciada', (partida) => {
            partidaActual = partida;
            // This will be handled in partida.html
        });

        socket.on('tu-rol', (data) => {
            miRol = data;
            // This will be handled in partida.html
        });

        socket.on('jugador-expulsado', (data) => {
            // This will be handled in partida.html
        });

        socket.on('partida-finalizada', (data) => {
            // This will be handled in partida.html
        });

        socket.on('lista-paquetes', (paquetes) => {
            // This will be handled in partida.html (for game config)
        });

        socket.on('lista-mis-paquetes', (paquetes) => {
            // This will be handled in paquetes.html
        });

        socket.on('paquete-actualizado', (data) => {
            // This will be handled in paquetes.html
        });

        socket.on('palabra-anadida', (palabra) => {
            // This will be handled in paquetes.html
        });

        socket.on('palabra-eliminada', (data) => {
            // This will be handled in paquetes.html
        });

        socket.on('paquete-creado', (data) => {
            // This will be handled in paquetes.html
        });

        socket.on('paquete-eliminado', () => {
            // This will be handled in paquetes.html
        });

        socket.on('paquete-estado-compartir-actualizado', (data) => {
            // This will be handled in paquetes.html
        });

        socket.on('detalle-paquete', (data) => {
            // This will be handled in paquetes.html
        });

        socket.on('actualizar-tiempo', (data) => {
            // This will be handled in partida.html
        });

        socket.on('qr-generado', (data) => {
            // This will be handled in partida.html
        });

        socket.on('error', (data) => {
            showToast(data.mensaje);
        });

        socket.on('disconnect', () => {
            console.log('Desconectado del servidor');
            // Optionally redirect to home or show a message
        });

        // Toast Notification Function
        function showToast(message, duration = 3000) {
            let toast = document.getElementById('toast-notification');
            if (!toast) {
                toast = document.createElement('div');
                toast.id = 'toast-notification';
                Object.assign(toast.style, {
                    position: 'fixed',
                    bottom: '20px',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    backgroundColor: 'rgba(0, 0, 0, 0.7)',
                    color: 'white',
                    padding: '10px 20px',
                    borderRadius: '5px',
                    zIndex: '1000',
                    opacity: '0',
                    transition: 'opacity 0.5s ease-in-out',
                    textAlign: 'center',
                    fontSize: '1em'
                });
                document.body.appendChild(toast);
            }
            toast.textContent = message;
            toast.style.opacity = '1';

            setTimeout(() => {
                toast.style.opacity = '0';
            }, duration);
        }

        // Global navigation functions
        function volverInicio() {
            window.location.href = '/';
        }

        function mostrarLobby() {
            window.location.href = '/lobby.html';
        }

        function mostrarPaquetes() {
            window.location.href = '/paquetes.html';
        }

        // Placeholder for functions that will be moved to specific pages
        function empezar() { /* Implemented in index.html */ }
        function mostrarCrearPartidaModal() { /* Implemented in lobby.html */ }
        function cerrarCrearPartidaModal() { /* Implemented in lobby.html */ }
        function crearPartida() { /* Implemented in lobby.html */ }
        function unirsePartida(codigo, tienePassword) { /* Implemented in lobby.html */ }
        function intentarUnirseConPassword() { /* Implemented in lobby.html */ }
        function cerrarPasswordModal() { /* Implemented in lobby.html */ }
        function mostrarCrearPaquete() { /* Implemented in paquetes.html */ }
        function cerrarCrearPaquete() { /* Implemented in paquetes.html */ }
        function crearPaquete() { /* Implemented in paquetes.html */ }
        function mostrarDetallePaquete(paqueteId) { /* Implemented in paquetes.html */ }
        function actualizarEstadoCompartirPaquete() { /* Implemented in paquetes.html */ }
        function salirPartida() { /* Implemented in partida.html */ }
        function compartirPartida() { /* Implemented in partida.html */ }
        function cerrarModal() { /* Implemented in partida.html */ }
        function copiarCodigo() { /* Implemented in partida.html */ }
        function mostrarQR() { /* Implemented in partida.html */ }
        function actualizarNumImpostores() { /* Implemented in partida.html */ }
        function iniciarPartida() { /* Implemented in partida.html */ }
        function siguienteTurno() { /* Implemented in partida.html */ }
        function votar(jugadorId) { /* Implemented in partida.html */ }
        function volverJugar() { /* Implemented in partida.html */ }
        function anadirPalabra() { /* Implemented in paquetes.html */ }
        function eliminarPalabra(palabraId) { /* Implemented in paquetes.html */ }
        function eliminarPaquete() { /* Implemented in paquetes.html */ }
        function guardarPaquete(paqueteId) { /* Implemented in paquetes.html */ }
        function mostrarListaPaquetes(paquetes) { /* Implemented in partida.html */ }
        function togglePaquete(element) { /* Implemented in partida.html */ }
        function toggleRol(forceShow = false) { /* Implemented in partida.html */ }
        function mostrarMiRol() { /* Implemented in partida.html */ }
        function actualizarJuego() { /* Implemented in partida.html */ }
        function mostrarVotacion() { /* Implemented in partida.html */ }
        function mostrarResultadoVotacion(data) { /* Implemented in partida.html */ }
        function mostrarPantallaFinal(data) { /* Implemented in partida.html */ }
        function actualizarSalaEspera() { /* Implemented in partida.html */ }
