@echo off
echo Iniciando servidor local para Warframe Market Web App...
echo.
echo La web se abrira en tu navegador predeterminado.
echo Mantien esta ventana abierta mientras uses la aplicacion.
echo (Para cerrar el servidor, simplemente cierra esta ventana).
echo.

start http://localhost:8000
node server.js
