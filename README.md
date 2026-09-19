# SmartScanCargo

Interface web para leitura sequencial de imagens de raio X e HEMD, criação de bounding boxes com equalização de histograma e gravação dos relatórios diretamente na pasta selecionada.

## Navegadores compatíveis

Use uma versão atual do Google Chrome ou Microsoft Edge. A aplicação utiliza a File System Access API para ler e gravar na pasta escolhida pelo usuário.

## Estrutura esperada da pasta

```text
cargas/
├── Imagem1/
│   ├── xray1.png
│   ├── hemd1.png
│   └── InfoSuspeitas1.txt
├── Imagem2/
│   ├── xray2.png
│   ├── hemd2.png
│   └── InfoSuspeitas2.txt
└── ...
```

O arquivo `InfoSuspeitas<índice>.txt` pode utilizar `:` ou `=` para separar chaves e valores. São lidos os campos `suspeito`, `mercadoria_nf`, `des_conteudo` e `mercadoria_manifestada`.

## Execução local

Por segurança do navegador, execute o projeto por um servidor local. No diretório do projeto:

```bash
python -m http.server 8000 --directory dist
```

Depois, acesse `http://localhost:8000` no Chrome ou Edge.

## Publicação no GitHub Pages

O projeto inclui um workflow de publicação. Crie um repositório, envie todos os arquivos e, nas configurações do GitHub Pages, selecione **GitHub Actions** como origem.

## Relatórios

Ao clicar em **Gerar Relatório**, a aplicação cria a pasta `Relatorios` dentro da pasta principal selecionada. Somente o arquivo `Relatorio<índice>.txt` correspondente à carga atual é criado ou substituído; os demais relatórios são preservados.
