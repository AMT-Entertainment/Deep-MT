{
  "apps": [
    {
      "name": "deepmt-server",
      "cwd": "./server",
      "script": "src/index.js",
      "interpreter": "node",
      "env": {
        "NODE_ENV": "production",
        "PORT": "3000"
      },
      "autorestart": true,
      "max_memory_restart": "512M",
      "time": true
    },
    {
      "name": "deepmt-imagegen",
      "cwd": "./server/imagegen",
      "script": "./imagegen.sh",
      "interpreter": "bash",
      "autorestart": true,
      "max_memory_restart": "8G",
      "time": true
    },
    {
      "name": "deepmt-engine",
      "script": "bash",
      "args": "-c \"exec $HOME/turbo-fieldfare/.build/release/TurboFieldfareServer --model $HOME/turbo-fieldfare/scratch/gemma4.gturbo --port 8080 --max-context 16384\"",
      "autorestart": true,
      "max_memory_restart": "4G",
      "time": true,
      "enabled": false
    }
  ]
}
